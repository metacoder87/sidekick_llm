const os = require('node:os');
const { createHash, createHmac } = require('node:crypto');

const LEMON_SQUEEZY_API_URL = 'https://api.lemonsqueezy.com/v1/licenses';
const OFFLINE_GRACE_PERIOD_DAYS = 30;
const OFFLINE_GRACE_PERIOD_MS = OFFLINE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const HMAC_SECRET = 'sidekick-llm-license-vault-signature-salt-v1';

/**
 * Generate a hardware-bound machine identifier string.
 */
function getMachineId() {
  const cpus = os.cpus();
  const rawId = [
    os.platform(),
    os.arch(),
    os.hostname(),
    cpus.length > 0 ? cpus[0].model : 'cpu',
    os.totalmem(),
  ].join('|');

  return createHash('sha256').update(rawId).digest('hex');
}

/**
 * Compute tamper-evident HMAC signature for stored license fields.
 */
function computeSignature({ licenseKey, instanceId, expiresAt, lastVerifiedAt, machineId }) {
  const payload = [
    licenseKey || '',
    instanceId || '',
    expiresAt || 'null',
    lastVerifiedAt || '',
    machineId || '',
  ].join('::');

  return createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

class LicenseService {
  constructor({ repository, fetchFn = null, safeStorage = null }) {
    this.repository = repository;
    this.fetchFn = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    this.safeStorage = safeStorage;
    this.machineId = getMachineId();
  }

  /**
   * Internal helper to make requests to Lemon Squeezy API
   */
  async _requestApi(endpoint, data) {
    if (!this.fetchFn) {
      throw new Error('HTTP fetch is not available in the current environment.');
    }

    const url = `${LEMON_SQUEEZY_API_URL}/${endpoint}`;
    const body = new URLSearchParams(data).toString();

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let parsedMessage = `API request failed with HTTP ${response.status}`;
      try {
        const json = JSON.parse(errorText);
        if (json.error) parsedMessage = json.error;
      } catch (_e) {
        /* ignore JSON parse failure */
      }
      throw new Error(parsedMessage);
    }

    return response.json();
  }

  /**
   * Get the stored license record and evaluate entitlement status.
   */
  getStatus() {
    if (!this.repository) {
      return {
        isLicensed: false,
        status: 'unlicensed',
        reason: 'Repository not connected.',
      };
    }

    const licenseKey = this.repository.getSetting('licenseKey');
    const instanceId = this.repository.getSetting('licenseInstanceId');
    const expiresAt = this.repository.getSetting('licenseExpiresAt');
    const lastVerifiedAt = this.repository.getSetting('licenseLastVerifiedAt');
    const signature = this.repository.getSetting('licenseSignature');
    const customerEmail = this.repository.getSetting('licenseCustomerEmail');

    if (!licenseKey || !instanceId || !lastVerifiedAt || !signature) {
      return {
        isLicensed: false,
        status: 'unlicensed',
        reason: 'No active software license found.',
        customerEmail: null,
      };
    }

    // Verify tamper-evident signature
    const expectedSignature = computeSignature({
      licenseKey,
      instanceId,
      expiresAt,
      lastVerifiedAt,
      machineId: this.machineId,
    });

    if (signature !== expectedSignature) {
      return {
        isLicensed: false,
        status: 'tampered',
        reason: 'License verification failed — signature mismatch.',
        customerEmail: null,
      };
    }

    // Check expiration date if present
    const now = new Date();
    if (expiresAt && expiresAt !== 'null' && new Date(expiresAt) < now) {
      return {
        isLicensed: false,
        status: 'expired',
        reason: `License expired on ${new Date(expiresAt).toLocaleDateString()}`,
        expiresAt,
        customerEmail,
      };
    }

    // Check offline grace period
    const lastVerifiedDate = new Date(lastVerifiedAt);
    const ageMs = now.getTime() - lastVerifiedDate.getTime();
    const daysSinceVerified = ageMs / (1000 * 60 * 60 * 24);
    const daysRemainingInGrace = Math.max(
      0,
      Math.ceil(OFFLINE_GRACE_PERIOD_DAYS - daysSinceVerified),
    );

    if (ageMs > OFFLINE_GRACE_PERIOD_MS) {
      return {
        isLicensed: false,
        status: 'grace_period_expired',
        reason: `Offline grace period (${OFFLINE_GRACE_PERIOD_DAYS} days) has expired. Internet connection required to re-verify.`,
        expiresAt,
        lastVerifiedAt,
        customerEmail,
      };
    }

    return {
      isLicensed: true,
      status: 'active',
      licenseKey,
      instanceId,
      expiresAt: expiresAt === 'null' ? null : expiresAt,
      lastVerifiedAt,
      daysRemainingInGrace,
      customerEmail,
    };
  }

  /**
   * Activate a software license key via Lemon Squeezy API.
   */
  async activate(licenseKey) {
    if (!licenseKey || typeof licenseKey !== 'string' || !licenseKey.trim()) {
      throw new Error('Please enter a valid license key.');
    }

    const cleanKey = licenseKey.trim();
    const instanceName = `Sidekick-App-${this.machineId.slice(0, 8)}`;

    const response = await this._requestApi('activate', {
      license_key: cleanKey,
      instance_name: instanceName,
    });

    if (!response.activated) {
      const errorMsg = response.error || response.message || 'Activation failed.';
      throw new Error(errorMsg);
    }

    const instanceId = String(response.instance?.id || '');
    const expiresAt = response.license_key?.expires_at
      ? new Date(response.license_key.expires_at).toISOString()
      : null;
    const customerEmail = response.meta?.customer_email || response.license_key?.user_email || '';
    const lastVerifiedAt = new Date().toISOString();

    const signature = computeSignature({
      licenseKey: cleanKey,
      instanceId,
      expiresAt,
      lastVerifiedAt,
      machineId: this.machineId,
    });

    // Store in settings table
    this.repository.setSetting('licenseKey', cleanKey);
    this.repository.setSetting('licenseInstanceId', instanceId);
    this.repository.setSetting('licenseExpiresAt', expiresAt || 'null');
    this.repository.setSetting('licenseLastVerifiedAt', lastVerifiedAt);
    this.repository.setSetting('licenseCustomerEmail', customerEmail);
    this.repository.setSetting('licenseSignature', signature);

    if (this.repository.appendAudit) {
      this.repository.appendAudit({
        action: 'license.activate',
        detail: `Activated key ${cleanKey.slice(0, 8)}... instance ${instanceId}`,
      });
    }

    return this.getStatus();
  }

  /**
   * Validate the stored key with Lemon Squeezy API, refreshing lastVerifiedAt.
   */
  async validate() {
    const currentStatus = this.getStatus();
    if (!currentStatus.licenseKey || !currentStatus.instanceId) {
      return this.getStatus();
    }

    try {
      const response = await this._requestApi('validate', {
        license_key: currentStatus.licenseKey,
        instance_id: currentStatus.instanceId,
      });

      if (response.valid) {
        const lastVerifiedAt = new Date().toISOString();
        const expiresAt = response.license_key?.expires_at
          ? new Date(response.license_key.expires_at).toISOString()
          : currentStatus.expiresAt;

        const signature = computeSignature({
          licenseKey: currentStatus.licenseKey,
          instanceId: currentStatus.instanceId,
          expiresAt,
          lastVerifiedAt,
          machineId: this.machineId,
        });

        this.repository.setSetting('licenseLastVerifiedAt', lastVerifiedAt);
        this.repository.setSetting('licenseExpiresAt', expiresAt || 'null');
        this.repository.setSetting('licenseSignature', signature);

        if (this.repository.appendAudit) {
          this.repository.appendAudit({
            action: 'license.validate',
            detail: `Validated key ${currentStatus.licenseKey.slice(0, 8)}...`,
          });
        }
      } else {
        // Validation returned invalid key or disabled instance
        this.clearLicense();
      }
    } catch (_error) {
      // If network fails during background validation, retain existing grace period status
    }

    return this.getStatus();
  }

  /**
   * Deactivate license on Lemon Squeezy and clear local settings.
   */
  async deactivate() {
    const currentStatus = this.getStatus();
    if (currentStatus.licenseKey && currentStatus.instanceId) {
      try {
        await this._requestApi('deactivate', {
          license_key: currentStatus.licenseKey,
          instance_id: currentStatus.instanceId,
        });
      } catch (_e) {
        /* proceed to clear locally even if remote network call fails */
      }
    }

    this.clearLicense();
    return this.getStatus();
  }

  /**
   * Clear local license storage.
   */
  clearLicense() {
    if (!this.repository) return;
    this.repository.setSetting('licenseKey', '');
    this.repository.setSetting('licenseInstanceId', '');
    this.repository.setSetting('licenseExpiresAt', '');
    this.repository.setSetting('licenseLastVerifiedAt', '');
    this.repository.setSetting('licenseCustomerEmail', '');
    this.repository.setSetting('licenseSignature', '');

    if (this.repository.appendAudit) {
      this.repository.appendAudit({
        action: 'license.clear',
        detail: 'Cleared stored license credentials.',
      });
    }
  }

  /**
   * Entitlement check for premium features.
   */
  isFeatureAllowed(featureName) {
    const status = this.getStatus();
    if (status.isLicensed) return true;

    // Unlicensed allowed features: basic chat, settings, local Ollama models.
    const UNLICENSED_ALLOWED_FEATURES = new Set([
      'chat',
      'models',
      'settings',
      'profile',
      'memory',
    ]);

    if (UNLICENSED_ALLOWED_FEATURES.has(featureName)) {
      return true;
    }

    // Premium features (deepResearch, specialistHubs, roundtable) require an active license.
    return false;
  }
}

module.exports = {
  LicenseService,
  getMachineId,
  computeSignature,
  OFFLINE_GRACE_PERIOD_DAYS,
};
