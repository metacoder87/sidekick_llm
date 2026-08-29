import { useEffect, useState } from 'react';

export default function LicenseSettings({ sidekick }) {
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (!sidekick?.license) return undefined;

    let isCurrent = true;
    sidekick.license
      .status()
      .then((status) => {
        if (isCurrent) setLicenseStatus(status);
      })
      .catch((err) => {
        console.warn('Could not load license status:', err);
      });

    return () => {
      isCurrent = false;
    };
  }, [sidekick]);

  async function handleActivate(e) {
    e.preventDefault();
    if (!licenseKeyInput.trim() || !sidekick || !sidekick.license) return;

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const updatedStatus = await sidekick.license.activate(licenseKeyInput.trim());
      setLicenseStatus(updatedStatus);
      setLicenseKeyInput('');
      setSuccessMsg('License activated successfully! Full software entitlement unlocked.');
    } catch (err) {
      setErrorMsg(err.message || 'Failed to activate license. Please check your key.');
    } finally {
      setLoading(false);
    }
  }

  async function handleReverify() {
    if (!sidekick || !sidekick.license) return;
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const updatedStatus = await sidekick.license.validate();
      setLicenseStatus(updatedStatus);
      if (updatedStatus.isLicensed) {
        setSuccessMsg('License verified online! 30-day offline grace period refreshed.');
      } else {
        setErrorMsg('Online verification failed. ' + (updatedStatus.reason || ''));
      }
    } catch (_err) {
      setErrorMsg('Re-verification failed. Please check your internet connection.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivate() {
    if (!sidekick || !sidekick.license) return;
    if (!window.confirm('Are you sure you want to deactivate this license key on this machine?')) {
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const updatedStatus = await sidekick.license.deactivate();
      setLicenseStatus(updatedStatus);
      setSuccessMsg('License deactivated on this device.');
    } catch (err) {
      setErrorMsg('Deactivation error: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function maskKey(key) {
    if (!key || key.length < 8) return '••••-••••-••••-••••';
    return `${key.slice(0, 4)}-••••-••••-${key.slice(-4)}`;
  }

  return (
    <div className="license-settings-panel">
      <div className="license-header">
        <h3>🔑 Software License & Activation</h3>
        <p className="modal-description">
          Sidekick LLM runs 100% locally. Enter your Lemon Squeezy yearly subscription key below to
          unlock lifetime updates and unlimited Specialist Hub research features.
        </p>
      </div>

      {statusMessageBanner(successMsg, errorMsg)}

      {licenseStatus && licenseStatus.isLicensed ? (
        <div className="license-active-card">
          <div className="license-badge-row">
            <span className="badge badge-success">✓ ACTIVE LICENSE</span>
            {licenseStatus.daysRemainingInGrace !== undefined && (
              <span className="badge badge-info">
                📶 {licenseStatus.daysRemainingInGrace} Days Offline Grace Period
              </span>
            )}
          </div>

          <div className="license-details-grid">
            <div className="detail-item">
              <span className="detail-label">License Key</span>
              <span className="detail-value mono">{maskKey(licenseStatus.licenseKey)}</span>
            </div>
            {licenseStatus.customerEmail && (
              <div className="detail-item">
                <span className="detail-label">Registered Owner</span>
                <span className="detail-value">{licenseStatus.customerEmail}</span>
              </div>
            )}
            <div className="detail-item">
              <span className="detail-label">Expiration Date</span>
              <span className="detail-value">
                {licenseStatus.expiresAt
                  ? new Date(licenseStatus.expiresAt).toLocaleDateString()
                  : 'Yearly License (Active)'}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Last Online Verification</span>
              <span className="detail-value">
                {licenseStatus.lastVerifiedAt
                  ? new Date(licenseStatus.lastVerifiedAt).toLocaleString()
                  : 'N/A'}
              </span>
            </div>
          </div>

          <div className="license-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={handleReverify}
              disabled={loading}
            >
              {loading ? 'Verifying...' : '🔄 Verify Online Now'}
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={handleDeactivate}
              disabled={loading}
            >
              Unlink Machine
            </button>
          </div>
        </div>
      ) : (
        <div className="license-activate-card">
          <div className="license-badge-row">
            {licenseStatus?.status === 'grace_period_expired' ? (
              <span className="badge badge-warning">⚠️ OFFLINE GRACE EXPIRED</span>
            ) : licenseStatus?.status === 'expired' ? (
              <span className="badge badge-danger">❌ LICENSE EXPIRED</span>
            ) : licenseStatus?.status === 'tampered' ? (
              <span className="badge badge-danger">🚨 SIGNATURE INVALID</span>
            ) : (
              <span className="badge badge-neutral">⚪ UNLICENSED MODE</span>
            )}
          </div>

          {licenseStatus?.reason && <p className="license-status-reason">{licenseStatus.reason}</p>}

          <form onSubmit={handleActivate} className="license-activate-form">
            <label className="form-field">
              <span>Lemon Squeezy License Key</span>
              <input
                type="text"
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                value={licenseKeyInput}
                onChange={(e) => setLicenseKeyInput(e.target.value)}
                className="mono-input"
                required
              />
            </label>

            <div className="modal-actions">
              <button type="submit" className="primary-button" disabled={loading}>
                {loading ? 'Activating...' : 'Activate License'}
              </button>
              <a
                href="https://lemonsqueezy.com"
                target="_blank"
                rel="noreferrer"
                className="secondary-button-link"
              >
                🛒 Buy License ($39/yr)
              </a>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function statusMessageBanner(successMsg, errorMsg) {
  if (successMsg) {
    return <div className="banner banner-success">{successMsg}</div>;
  }
  if (errorMsg) {
    return <div className="banner banner-error">{errorMsg}</div>;
  }
  return null;
}
