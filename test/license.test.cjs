const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConversationRepository } = require('../electron/repository.cjs');
const {
  LicenseService,
  computeSignature,
  getMachineId,
} = require('../electron/licenseService.cjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lic-test-'));
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (_e) {
    /* ignore */
  }
}

test('LicenseService - initial unlicensed state', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'test.db');
  const repo = new ConversationRepository(dbPath);

  try {
    const licenseService = new LicenseService({ repository: repo });
    const status = licenseService.getStatus();

    assert.equal(status.isLicensed, false);
    assert.equal(status.status, 'unlicensed');
    assert.equal(licenseService.isFeatureAllowed('chat'), true);
    assert.equal(licenseService.isFeatureAllowed('deepResearch'), false);
    assert.equal(licenseService.isFeatureAllowed('specialistHubs'), false);
  } finally {
    repo.close();
    rmDir(dir);
  }
});

test('LicenseService - successful activation flow with mock API', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'test.db');
  const repo = new ConversationRepository(dbPath);

  const mockFetch = async (url, options) => {
    assert.ok(url.endsWith('/activate'));
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      json: async () => ({
        activated: true,
        instance: { id: 'inst_12345' },
        license_key: {
          expires_at: '2027-12-31T23:59:59Z',
          user_email: 'buyer@example.com',
        },
        meta: {
          customer_email: 'buyer@example.com',
        },
      }),
    };
  };

  try {
    const licenseService = new LicenseService({ repository: repo, fetchFn: mockFetch });
    const status = await licenseService.activate('LS-1234-5678-ABCD-EFGH');

    assert.equal(status.isLicensed, true);
    assert.equal(status.status, 'active');
    assert.equal(status.licenseKey, 'LS-1234-5678-ABCD-EFGH');
    assert.equal(status.instanceId, 'inst_12345');
    assert.equal(status.customerEmail, 'buyer@example.com');
    assert.ok(status.daysRemainingInGrace >= 29);

    // Verify feature access unlocked
    assert.equal(licenseService.isFeatureAllowed('deepResearch'), true);
    assert.equal(licenseService.isFeatureAllowed('specialistHubs'), true);
  } finally {
    repo.close();
    rmDir(dir);
  }
});

test('LicenseService - offline grace period logic', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'test.db');
  const repo = new ConversationRepository(dbPath);

  try {
    const licenseService = new LicenseService({ repository: repo });
    const key = 'LS-9999-8888';
    const instanceId = 'inst_999';
    const machineId = getMachineId();

    // Simulate verified 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const sig10 = computeSignature({
      licenseKey: key,
      instanceId,
      expiresAt: 'null',
      lastVerifiedAt: tenDaysAgo,
      machineId,
    });

    repo.setSetting('licenseKey', key);
    repo.setSetting('licenseInstanceId', instanceId);
    repo.setSetting('licenseExpiresAt', 'null');
    repo.setSetting('licenseLastVerifiedAt', tenDaysAgo);
    repo.setSetting('licenseSignature', sig10);

    const status10 = licenseService.getStatus();
    assert.equal(status10.isLicensed, true);
    assert.equal(status10.status, 'active');
    assert.equal(status10.daysRemainingInGrace, 20);

    // Simulate verified 35 days ago (grace period expired)
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const sig35 = computeSignature({
      licenseKey: key,
      instanceId,
      expiresAt: 'null',
      lastVerifiedAt: thirtyFiveDaysAgo,
      machineId,
    });

    repo.setSetting('licenseLastVerifiedAt', thirtyFiveDaysAgo);
    repo.setSetting('licenseSignature', sig35);

    const status35 = licenseService.getStatus();
    assert.equal(status35.isLicensed, false);
    assert.equal(status35.status, 'grace_period_expired');
  } finally {
    repo.close();
    rmDir(dir);
  }
});

test('LicenseService - detects SQLite settings tampering', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'test.db');
  const repo = new ConversationRepository(dbPath);

  try {
    const licenseService = new LicenseService({ repository: repo });
    const key = 'LS-REAL-KEY';
    const instanceId = 'inst_real';
    const machineId = getMachineId();
    const nowIso = new Date().toISOString();

    const signature = computeSignature({
      licenseKey: key,
      instanceId,
      expiresAt: 'null',
      lastVerifiedAt: nowIso,
      machineId,
    });

    repo.setSetting('licenseKey', key);
    repo.setSetting('licenseInstanceId', instanceId);
    repo.setSetting('licenseExpiresAt', 'null');
    repo.setSetting('licenseLastVerifiedAt', nowIso);
    repo.setSetting('licenseSignature', signature);

    assert.equal(licenseService.getStatus().isLicensed, true);

    // User manually modifies key in SQLite settings table without signature
    repo.setSetting('licenseKey', 'LS-FORGED-KEY');

    const tamperedStatus = licenseService.getStatus();
    assert.equal(tamperedStatus.isLicensed, false);
    assert.equal(tamperedStatus.status, 'tampered');
  } finally {
    repo.close();
    rmDir(dir);
  }
});

test('LicenseService - deactivation flow', async () => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'test.db');
  const repo = new ConversationRepository(dbPath);

  let deactivatedCalled = false;
  const mockFetch = async (url) => {
    if (url.endsWith('/deactivate')) {
      deactivatedCalled = true;
      return { ok: true, json: async () => ({ deactivated: true }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const licenseService = new LicenseService({ repository: repo, fetchFn: mockFetch });
    const key = 'LS-DEACT-KEY';
    const instanceId = 'inst_deact';
    const machineId = getMachineId();
    const nowIso = new Date().toISOString();

    const signature = computeSignature({
      licenseKey: key,
      instanceId,
      expiresAt: 'null',
      lastVerifiedAt: nowIso,
      machineId,
    });

    repo.setSetting('licenseKey', key);
    repo.setSetting('licenseInstanceId', instanceId);
    repo.setSetting('licenseExpiresAt', 'null');
    repo.setSetting('licenseLastVerifiedAt', nowIso);
    repo.setSetting('licenseSignature', signature);

    assert.equal(licenseService.getStatus().isLicensed, true);

    const deactStatus = await licenseService.deactivate();

    assert.equal(deactivatedCalled, true);
    assert.equal(deactStatus.isLicensed, false);
    assert.equal(deactStatus.status, 'unlicensed');
  } finally {
    repo.close();
    rmDir(dir);
  }
});
