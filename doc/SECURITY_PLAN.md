# ERPLibre Home Mobile -- Comprehensive Security Plan

**Date**: 2026-04-14
**Version**: 1.0.0
**Classification**: CONFIDENTIAL -- Internal Use Only
**License**: AGPL-3.0+
**Target posture**: Banking-grade mobile application

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope and Methodology](#2-scope-and-methodology)
3. [Current State Assessment](#3-current-state-assessment)
4. [Authentication and Authorization](#4-authentication-and-authorization)
5. [Data Protection](#5-data-protection)
6. [Secure Storage](#6-secure-storage)
7. [Network Security](#7-network-security)
8. [Code Security](#8-code-security)
9. [Compliance -- PIPEDA, GDPR, Banking](#9-compliance----pipeda-gdpr-banking)
10. [OWASP Mobile Top 10 Assessment](#10-owasp-mobile-top-10-assessment)
11. [Incident Response](#11-incident-response)
12. [CI/CD Security](#12-cicd-security)
13. [Prioritized Recommendations](#13-prioritized-recommendations)
14. [Risk Register](#14-risk-register)
15. [Implementation Roadmap](#15-implementation-roadmap)

---

## 1. Executive Summary

ERPLibre Home Mobile is a Capacitor 8 / Owl 2.8.1 / TypeScript application targeting
Android (and eventually iOS) that provides note-taking, Odoo ERP synchronization, SSH
server management, and on-device audio transcription. The app is positioned for
banking-grade deployments connecting to financial Odoo instances.

This security plan is the output of a coordinated analysis by seven specialist roles:
**system-architect**, **security-specialist**, **compliance-specialist**,
**data-governance**, **risk-manager**, **penetration-tester**, and
**legal-license-advisor**. Each role independently analyzed the current source code
under `/home/leo/erplibre01/mobile/erplibre_home_mobile/` and produced findings that
were cross-referenced to produce this unified plan.

**Overall assessment**: The application has a *solid foundation* in several areas
(encrypted SQLite with key in SecureStorage, biometric gating, parameterized SQL
queries, use of Capacitor's SecureStoragePlugin). However, multiple **Critical** and
**High** severity gaps remain that must be addressed before the application can meet
banking-grade security requirements. The most urgent issues are: cleartext traffic
enabled globally, debug keystore committed to version control with hardcoded password,
SSH host key verification disabled, no TLS certificate pinning, plaintext credentials
stored in the encrypted database, and no code obfuscation or anti-tampering measures.

---

## 2. Scope and Methodology

### 2.1 Files Analyzed

| Category | Key Files |
|----------|-----------|
| App configuration | `capacitor.config.json`, `package.json`, `vite.config.ts` |
| Android native | `AndroidManifest.xml`, `build.gradle`, `MainActivity.java` |
| Native plugins | `SshPlugin.java`, `RawHttpPlugin.java`, `NetworkScanPlugin.java`, `WhisperPlugin.java`, `OcrPlugin.java` |
| Authentication | `biometryUtils.ts`, `storageUtils.ts` |
| Database | `databaseService.ts`, `migrationService.ts` |
| Network/Sync | `syncService.ts`, `ntfyService.ts`, `notificationService.ts`, `rawHttpPlugin.ts` |
| Server management | `serverService.ts`, `deploymentService.ts`, `sshPlugin.ts` |
| Models | `application.ts`, `server.ts`, `syncConfig.ts` |
| Build scripts | `generate-keystore.sh`, `build-android.sh` |
| Environment | `.env.production`, `.env.staging` |

### 2.2 Methodology

- Static analysis of all TypeScript and Java source files
- Configuration review of Android manifest, Gradle, Capacitor, and Vite
- Dependency inventory from `package.json`
- OWASP Mobile Top 10 (2024) mapping
- PIPEDA / GDPR / Canadian banking regulation cross-reference
- Threat modeling using STRIDE methodology

---

## 3. Current State Assessment

### 3.1 What Is Already Done Well

| Control | Status | Notes |
|---------|--------|-------|
| SQLite encryption (SQLCipher) | Implemented | 256-bit random key generated via `crypto.getRandomValues()` |
| Encryption key in SecureStorage | Implemented | Key stored in Android Keystore-backed SecureStoragePlugin |
| Biometric authentication | Implemented | Gates database access at app startup |
| Parameterized SQL queries | Implemented | All DB methods use `?` placeholders, no string interpolation |
| Session stored in SecureStorage | Implemented | Odoo session IDs persisted via SecureStoragePlugin |
| Schema migration system | Implemented | CalVer-stamped, idempotent, with history tracking |
| Content Security Policy | Partial | `user-scalable=no` set (prevents zoom-based attacks) |

### 3.2 Critical Gaps Summary

| Gap | Severity | Section |
|-----|----------|---------|
| `android:usesCleartextTraffic="true"` in manifest | **Critical** | 7.1 |
| Debug keystore committed with hardcoded password "android" | **Critical** | 12.1 |
| SSH `StrictHostKeyChecking` set to "no" | **Critical** | 7.4 |
| Odoo passwords stored as plaintext columns in encrypted DB | **High** | 5.2 |
| SSH passwords/private keys stored as plaintext in encrypted DB | **High** | 5.2 |
| No TLS certificate pinning | **High** | 7.2 |
| Vite `minify: false` in production build | **High** | 8.1 |
| Android `minifyEnabled false` (no ProGuard/R8) | **High** | 8.2 |
| No Content Security Policy headers | **High** | 8.3 |
| NTFY SSE over unauthenticated connection | **High** | 7.5 |
| Unsafe DOM injection in webViewUtils.ts | **Medium** | 8.4 |
| Login auto-fill script injects credentials via string interpolation | **Medium** | 4.5 |
| No dependency vulnerability scanning | **Medium** | 12.2 |
| External CDN script in `index.html` (unpkg.com) | **Medium** | 8.5 |
| Excessive Android permissions | **Medium** | 7.6 |
| JSch library (0.1.55) is unmaintained/vulnerable | **Medium** | 12.3 |
| No session timeout/expiry enforcement | **Medium** | 4.3 |
| Console.log may leak sensitive data in production | **Low** | 8.6 |

---

## 4. Authentication and Authorization

### 4.1 Current Authentication Architecture

```
App Launch
    |
    v
[Biometric Check] --> (if enabled + available) --> [BiometricAuth.authenticate()]
    |                                                      |
    | (skip if disabled/unavailable)                       |
    v                                                      v
[DatabaseService.initialize()]                        [success/fail]
    |
    v
[getOrCreateEncryptionKey() from SecureStorage]
    |
    v
[SQLCipher opens encrypted DB]
```

**Odoo Authentication Flow:**
```
[User enters URL + username + password]
    |
    v
[SyncService.authenticate()] --> POST /web/session/authenticate
    |
    v
[Session ID extracted from Set-Cookie / CookieManager / JSON body]
    |
    v
[Session stored in SecureStoragePlugin]
    |
    v
[Subsequent API calls use Cookie: session_id=... header]
```

### 4.2 Finding: No PIN Fallback for Biometric Authentication
**Severity: Medium**

The biometric auth check in `biometryUtils.ts` has no PIN/pattern fallback. If
biometric hardware fails or the user's fingerprint is not recognized, the app
displays "Authentification biometrique echouee. Relancez l'application." and
becomes inaccessible. This is a usability and availability issue.

**Recommendation:**
- Implement a secure PIN entry (6+ digits) as fallback when biometric fails
- Store PIN hash (bcrypt/Argon2) in SecureStorage
- Limit PIN attempts (5 attempts, then exponential backoff)
- Consider Android's `setDeviceCredentialAllowed(true)` to allow device PIN/pattern

### 4.3 Finding: No Session Timeout Enforcement
**Severity: Medium**

The Odoo session ID stored in SecureStorage has no local expiry. The app relies
entirely on Odoo's server-side session expiry. If a session is compromised, it
remains valid until the server expires it.

**Recommendation:**
- Store session creation timestamp alongside session ID
- Enforce a maximum session age (configurable, default 24 hours)
- Force re-authentication after the app has been in background for > N minutes
- Clear sessions on biometric re-enrollment events

### 4.4 Finding: No Authorization Model for Local Data
**Severity: Low**

All data in the SQLite database is accessible once the encryption key is obtained.
There is no row-level or table-level access control distinguishing between
different Odoo server connections.

**Recommendation (for multi-tenant deployments):**
- Consider per-server database segmentation
- Tag all rows with a `server_id` for future access control
- This is lower priority unless multi-user scenarios are planned

### 4.5 Finding: Credential Injection in Auto-Login Script
**Severity: Medium**

In `applications_component.ts` (line ~418-419), the auto-login script for the
in-app browser injects credentials via JavaScript string interpolation:

```
setInputValue(userEl, "${matchingApp.username}");
setInputValue(passEl, "${matchingApp.password}");
```

If a username or password contains a `"`, `\`, or backtick, this could break the
script or enable injection in the WebView context.

**Recommendation:**
- Escape credentials before injecting into the script string
- Use a safer injection mechanism (e.g., `postMessage` from native to WebView)
- Consider using Capacitor's `WebView.evaluateJavascript()` with proper parameter binding

---

## 5. Data Protection

### 5.1 Data Classification

| Data Type | Classification | Current Protection | Required Protection |
|-----------|---------------|-------------------|-------------------|
| SQLite encryption key | **SECRET** | SecureStorage (Keystore-backed) | Adequate |
| Biometric enrollment state | **INTERNAL** | SecureStorage | Adequate |
| Odoo session IDs | **CONFIDENTIAL** | SecureStorage | Adequate |
| Odoo passwords | **SECRET** | Plaintext in encrypted DB | Needs additional encryption |
| SSH passwords | **SECRET** | Plaintext in encrypted DB | Needs additional encryption |
| SSH private keys | **SECRET** | Plaintext in encrypted DB | Needs additional encryption |
| SSH passphrases | **SECRET** | Plaintext in encrypted DB | Needs additional encryption |
| NTFY URLs/Topics | **INTERNAL** | Plaintext in encrypted DB | Adequate |
| Note content (text) | **CONFIDENTIAL** | Encrypted DB | Adequate |
| Note content (photos/videos) | **CONFIDENTIAL** | Filesystem (unencrypted) | Needs encryption |
| Geolocation data | **CONFIDENTIAL** | Encrypted DB | Adequate |
| Audio recordings | **CONFIDENTIAL** | Filesystem (unencrypted) | Needs encryption |
| Whisper model binaries | **PUBLIC** | Filesystem | Adequate |
| Schema version | **INTERNAL** | SecureStorage | Adequate |
| Migration history | **INTERNAL** | SecureStorage | Adequate |

### 5.2 Finding: Plaintext Credentials in Encrypted Database
**Severity: High**

The `applications` table stores Odoo passwords in a plaintext `password TEXT` column.
The `servers` table stores SSH passwords, private keys, and passphrases in plaintext
columns. While the database itself is encrypted with SQLCipher, this provides only
one layer of defense. If the encryption key is compromised (e.g., through a root
exploit or memory dump), all credentials are immediately exposed.

**Current schema (applications):**
```sql
CREATE TABLE applications (
    url TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,           -- PLAINTEXT
    PRIMARY KEY (url, username)
)
```

**Current schema (servers):**
```sql
CREATE TABLE servers (
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL DEFAULT 22,
    username     TEXT NOT NULL,
    auth_type    TEXT NOT NULL DEFAULT 'password',
    password     TEXT NOT NULL DEFAULT '',    -- PLAINTEXT
    private_key  TEXT NOT NULL DEFAULT '',    -- PLAINTEXT
    passphrase   TEXT NOT NULL DEFAULT '',    -- PLAINTEXT
    ...
)
```

**Recommendation:**
- Encrypt credential fields with a secondary key derived from the user's biometric/PIN
- Use AES-256-GCM with a per-credential random IV
- Store the secondary key in Android Keystore with biometric binding
  (`setUserAuthenticationRequired(true)`)
- Alternatively, move all credentials to SecureStorage (Keystore-backed) and
  store only references in the database

### 5.3 Finding: Media Files Stored Unencrypted on Filesystem
**Severity: Medium**

Photos, videos, and audio recordings referenced by note entries are stored on the
Android filesystem without encryption. On a rooted device, these files are directly
accessible.

**Recommendation:**
- Use Capacitor Filesystem to write media to the app's internal storage (`Directory.Data`)
- Implement file-level encryption using AES-256-GCM before writing
- Store the file encryption key in SecureStorage
- Delete plaintext temporary files after encryption
- Consider Android's encrypted file system APIs (EncryptedFile from Jetpack Security)

### 5.4 Data Retention Policy

No data retention policy is currently implemented. For PIPEDA/GDPR compliance:

- **Notes**: Retain until user explicitly deletes. Offer bulk export + delete
- **Credentials**: Expire after configurable period (default 90 days)
- **Session IDs**: Expire after 24 hours maximum
- **Geolocation data**: Warn user; offer option to strip from synced data
- **Audio recordings**: Offer auto-delete after transcription option
- **Sync history**: Retain 90 days maximum, then auto-purge
- **Process logs**: Retain 30 days maximum (may contain debug data)

---

## 6. Secure Storage

### 6.1 Current Architecture

```
SecureStoragePlugin (capacitor-secure-storage-plugin v0.13.0)
    |
    +--> Android: EncryptedSharedPreferences
    |       +--> Master key in Android Keystore (hardware-backed where available)
    |
    +--> iOS: Keychain (when iOS is added)
```

**Items currently in SecureStorage:**
- `db_encryption_key` -- 256-bit hex string
- `biometry_enabled` -- boolean flag
- `odoo_sync_session_*` -- per-server session data
- `schema_version` -- integer
- `migration_history` -- JSON array
- `odoo_sync_config` / `odoo_sync_configs` -- sync configuration
- `dev_mode_unlocked` -- debug flag

### 6.2 Finding: SecureStorage Plugin Version
**Severity: Low**

`capacitor-secure-storage-plugin` v0.13.0 is used. This is a community plugin.
Verify it uses `EncryptedSharedPreferences` (Jetpack Security) on Android, which
provides AES-256-SIV for keys and AES-256-GCM for values, backed by Android Keystore.

**Recommendation:**
- Audit the plugin source to confirm Keystore backing on the target Android versions
- Consider StrongBox Keymaster (`setIsStrongBoxBacked(true)`) for hardware security
  module (HSM) backing where available
- Pin the plugin version in `package.json` (currently uses `^0.13.0` which allows
  minor version drift)

### 6.3 Finding: Encryption Key Generation
**Severity: Low -- Currently Adequate**

The encryption key is generated correctly using `crypto.getRandomValues(32)` (256 bits
of CSPRNG). The key is persisted in SecureStorage on first use and reused thereafter.
This is a good pattern.

**Recommendation for banking-grade enhancement:**
- Bind the encryption key to biometric authentication using Android Keystore's
  `setUserAuthenticationRequired(true)` with `setUserAuthenticationValidityDurationSeconds(0)`
  (require biometric per use)
- This prevents key extraction even if the device is rooted while locked

---

## 7. Network Security

### 7.1 Finding: Cleartext Traffic Enabled Globally
**Severity: CRITICAL**

`AndroidManifest.xml` line 11:
```xml
android:usesCleartextTraffic="true"
```

This allows HTTP (non-TLS) communication for all network requests. In a banking-grade
application, this exposes all data to network interception (MITM), including Odoo
credentials, session IDs, note content, and SSH credentials transmitted via the
sync service.

**Evidence of cleartext usage in code:**
- `syncService.ts` normalizeUrl() defaults to `https://` but accepts `http://`
- `RawHttpPlugin.java` uses `HttpURLConnection` which follows the manifest setting
- `ntfyService.ts` connects to user-provided URLs without protocol enforcement

**Recommendation:**
- Set `android:usesCleartextTraffic="false"` in AndroidManifest.xml
- Add a Network Security Config (`res/xml/network_security_config.xml`) that:
  - Denies cleartext traffic globally
  - Optionally permits cleartext only for `localhost` / `10.0.2.2` in debug builds
- Enforce HTTPS in `syncService.ts` normalizeUrl() -- reject `http://` URLs entirely
- Enforce HTTPS for NTFY connections
- Add a visible warning in the UI when the user enters an HTTP URL

### 7.2 Finding: No TLS Certificate Pinning
**Severity: High**

No certificate pinning is implemented anywhere in the application. The app trusts
the entire system certificate store, making it vulnerable to:
- Compromised Certificate Authorities
- Corporate proxy MITM (common in enterprise deployments)
- State-sponsored certificate injection

**Recommendation:**
- Implement certificate pinning in `network_security_config.xml` for known Odoo servers
- For user-configured Odoo servers: implement Trust-on-First-Use (TOFU) pinning
  - On first connection, store the server's certificate fingerprint in SecureStorage
  - On subsequent connections, verify the fingerprint matches
  - Alert the user if the certificate changes
- Consider OkHttp with CertificatePinner for the native HTTP plugin

### 7.3 Finding: RawHttpPlugin Bypasses Cookie Security
**Severity: Medium -- Architectural Trade-off**

`RawHttpPlugin.java` temporarily sets `CookieHandler.setDefault(null)` to bypass
Android's cookie management. While this solves the session_id delivery problem for
HTTP connections to IP addresses, it:
- Disables cookie security for all concurrent connections during the request
- Is not thread-safe (another thread could make a request during the null window)

**Recommendation:**
- Use `OkHttpClient` instead of `HttpURLConnection` -- OkHttp does not suffer from
  the CookieHandler interference
- Set per-connection cookie handling rather than global handler manipulation
- Add a synchronized block or ReentrantLock around the handler swap if OkHttp
  migration is not immediate

### 7.4 Finding: SSH Host Key Verification Disabled
**Severity: CRITICAL**

`SshPlugin.java` line 57-58:
```java
config.put("StrictHostKeyChecking", "no");
session.setConfig(config);
```

This completely disables SSH host key verification, making the SSH connection
vulnerable to man-in-the-middle attacks. An attacker on the network can impersonate
any SSH server and capture credentials (passwords, private keys) transmitted during
authentication.

**This is especially critical because the SSH plugin is used for:**
- Remote server management (root/sudo access)
- ERPLibre deployment (installing software on production servers)
- Executing arbitrary commands on remote machines

**Recommendation:**
- Implement a known_hosts store in SecureStorage or the encrypted database
- On first connection to a new host: display the server's fingerprint and require
  user confirmation (Trust-on-First-Use)
- On subsequent connections: verify the fingerprint matches the stored value
- If the fingerprint changes: display a prominent warning and require explicit
  user approval
- Replace JSch with Apache MINA SSHD or sshj, which have better host key
  verification APIs
- Display the host key fingerprint in the server settings UI

### 7.5 Finding: NTFY Service Uses Unauthenticated SSE
**Severity: High**

`ntfyService.ts` connects to the NTFY server using `EventSource` (Server-Sent
Events) without any authentication. Anyone who knows the topic name can:
- Subscribe and read all notifications (information disclosure)
- Publish messages that trigger sync operations (unauthorized triggering)

**Recommendation:**
- Support NTFY authentication tokens (Bearer or basic auth)
- Store the NTFY auth token in SecureStorage
- Use NTFY access control lists on the server side
- Validate incoming NTFY messages (message signature or HMAC)
- Rate-limit sync triggers from NTFY to prevent denial-of-service

### 7.6 Finding: Excessive Android Permissions
**Severity: Medium**

Current permissions in AndroidManifest.xml:
- `INTERNET` -- Required
- `WAKE_LOCK` -- Required (model downloads)
- `FOREGROUND_SERVICE` -- Required
- `FOREGROUND_SERVICE_DATA_SYNC` -- Required
- `POST_NOTIFICATIONS` -- Required
- `ACCESS_COARSE_LOCATION` -- Review: is coarse needed alongside fine?
- `ACCESS_FINE_LOCATION` -- Required for geolocation entries
- `RECORD_AUDIO` -- Required for voice recording
- `READ_EXTERNAL_STORAGE` -- Deprecated on API 33+, review necessity
- `WRITE_EXTERNAL_STORAGE` -- Deprecated on API 33+, review necessity

**Recommendation:**
- Remove `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` -- use scoped storage
  APIs instead (mandatory on API 30+)
- Remove `ACCESS_COARSE_LOCATION` -- only `ACCESS_FINE_LOCATION` is needed
- Add `android:maxSdkVersion="32"` to storage permissions if backward compatibility
  is required
- Request permissions at runtime only when the specific feature is used (already done
  by Capacitor plugins, but verify)

### 7.7 Finding: Network Scan Plugin Exposes Local Network Topology
**Severity: Medium**

`NetworkScanPlugin.java` scans the entire /24 subnet for SSH services. While useful
for server discovery, this:
- Exposes the local network topology to the app
- Could be used by malicious code (if the WebView is compromised) to map internal networks
- May trigger IDS/IPS alerts in corporate environments

**Recommendation:**
- Gate the network scan behind an explicit user action with a warning dialog
- Log scan activity to the process history
- Consider restricting scan to user-specified IP ranges
- Add a network scan permission toggle in settings

---

## 8. Code Security

### 8.1 Finding: Vite Production Build Not Minified
**Severity: High**

`vite.config.ts` line 7:
```typescript
minify: false,
```

The production build includes unminified, human-readable JavaScript in the APK.
This makes reverse engineering trivial -- all variable names, function names,
comments, and logic are preserved.

**Recommendation:**
- Set `minify: 'terser'` or `minify: 'esbuild'` for production builds
- Configure Terser to mangle variable names and remove comments
- Keep `minify: false` only in development/staging configurations

### 8.2 Finding: Android ProGuard/R8 Disabled
**Severity: High**

`android/app/build.gradle` line 27:
```gradle
minifyEnabled false
```

The Java/Kotlin code in the APK is not obfuscated. Combined with unminified
JavaScript, the entire application logic is transparent to any attacker with an
APK decompiler (jadx, apktool).

**Recommendation:**
- Enable R8 for release builds with `minifyEnabled true` and `shrinkResources true`
- Add ProGuard rules for Capacitor, JSch, and ML Kit to prevent runtime crashes
- Test thoroughly after enabling (R8 can break reflection-based code)

### 8.3 Finding: No Content Security Policy
**Severity: High**

The `index.html` has no Content-Security-Policy meta tag or HTTP header. The WebView
can load and execute scripts from any origin.

**Recommendation:**
- Add a CSP meta tag to `index.html` restricting script-src, connect-src, and object-src
- Block dynamic code execution via `script-src` (do not include `'unsafe-eval'`)
- Note: `'unsafe-inline'` may be needed for Owl's template compilation

### 8.4 Finding: Unsafe DOM Injection in webViewUtils.ts
**Severity: Medium**

`webViewUtils.ts` line 53 uses unsafe DOM manipulation to inject script content.
The code has a `// TODO not working the injection, not secure` comment acknowledging
the issue. This pattern enables XSS if the `script` parameter contains
attacker-controlled content.

**Recommendation:**
- Remove this code path entirely (it's marked as non-functional)
- Use `textContent` instead of unsafe DOM property assignment for script elements
- If desktop WebView injection is needed, use a proper CSP-compliant approach

### 8.5 Finding: External CDN Script Dependency
**Severity: Medium**

`index.html` lines 14-20 load scripts from `unpkg.com` at runtime with `@latest` tag:

Loading scripts from an external CDN at runtime:
- Creates a supply chain attack vector (CDN compromise, package hijacking)
- Breaks offline functionality
- The `@latest` tag means any future version is automatically loaded without review

**Recommendation:**
- Vendor the `@ionic/pwa-elements` package locally (npm install + bundle)
- Or pin to a specific version with SRI (Subresource Integrity) hash
- Prefer local vendoring for a banking-grade application

### 8.6 Finding: Console Logging May Leak Sensitive Data
**Severity: Low**

Seven console.log/warn/error calls exist in the service layer. In production, these
may leak sensitive information to the Android logcat, which is accessible to other
apps on rooted devices (or via ADB).

Specific concerns:
- `syncService.ts` logs authentication diagnostic details including session ID
  prefixes and URLs
- `databaseService.ts` logs initialization steps

**Recommendation:**
- Strip `console.log/warn/error` from production builds (Terser's `drop_console`)
- Or implement a logging service that:
  - Is a no-op in production
  - Never logs credentials, tokens, or full URLs
  - Optionally writes to an encrypted log file for debugging

### 8.7 Finding: No Runtime Integrity Checks
**Severity: Medium**

The application has no anti-tampering mechanisms:
- No APK signature verification at runtime
- No root/jailbreak detection
- No debugger detection
- No emulator detection
- No hook detection (Frida, Xposed)

**Recommendation for banking-grade:**
- Implement root detection using SafetyNet/Play Integrity API
- Add runtime debugger detection (`android.os.Debug.isDebuggerConnected()`)
- Detect Frida and Xposed framework presence
- Verify APK signature at runtime against a hardcoded hash
- Warn users on rooted devices; optionally block sensitive operations
- Consider commercial solutions: DexGuard, AppSolid, or Guardsquare

---

## 9. Compliance -- PIPEDA, GDPR, Banking

### 9.1 PIPEDA (Personal Information Protection and Electronic Documents Act)

PIPEDA applies because ERPLibre is Canadian (ca.erplibre.home) and processes
personal information of Canadian users.

| PIPEDA Principle | Current Status | Gap |
|-----------------|----------------|-----|
| **Accountability** | No DPO designated | Need privacy officer designation |
| **Identifying Purposes** | No privacy policy in app | Need in-app privacy notice |
| **Consent** | No consent mechanism for data collection | Need consent flow for geolocation, audio, camera |
| **Limiting Collection** | Collects geolocation, audio, photos, video | Review necessity of each data type |
| **Limiting Use** | Data used for stated features | Document data use purposes |
| **Accuracy** | Sync keeps data current | Adequate |
| **Safeguards** | Encryption at rest; gaps in transit | Address cleartext traffic, credential storage |
| **Openness** | No privacy policy | Need public privacy policy |
| **Individual Access** | No data export feature | Implement data portability |
| **Challenging Compliance** | No complaint mechanism | Need contact information |

**Required actions:**
1. Create an in-app privacy policy (bilingual EN/FR)
2. Implement consent dialogs before first use of geolocation, camera, microphone
3. Add data export functionality (right of access)
4. Add account/data deletion functionality (right of erasure)
5. Document data retention periods

### 9.2 GDPR (General Data Protection Regulation)

GDPR applies if the app is used by EU residents or processes data of EU data subjects
(e.g., syncing notes about EU customers from Odoo).

| GDPR Article | Requirement | Gap |
|-------------|-------------|-----|
| Art. 5 | Data minimization | Review if all collected data is necessary |
| Art. 6 | Lawful basis | No lawful basis documented |
| Art. 7 | Consent conditions | No granular consent mechanism |
| Art. 12-14 | Transparency | No privacy notice |
| Art. 15 | Right of access | No data export |
| Art. 17 | Right to erasure | Partial (can delete notes, but no full data wipe) |
| Art. 20 | Data portability | No export in machine-readable format |
| Art. 25 | Data protection by design | Encryption at rest implemented, but gaps exist |
| Art. 32 | Security of processing | Multiple gaps identified in this plan |
| Art. 33-34 | Breach notification | No incident response plan |
| Art. 35 | DPIA | No Data Protection Impact Assessment |

**Required actions:**
1. Conduct a Data Protection Impact Assessment (DPIA)
2. Implement granular consent management
3. Add data export in JSON format
4. Implement complete data erasure (including cached files, logs)
5. Document the legal basis for processing each data category

### 9.3 Canadian Banking Regulations

For banking-grade deployments, the following additional requirements apply:

| Regulation | Requirement | Status |
|-----------|-------------|--------|
| OSFI B-13 | Technology and Cyber Risk Management | Multiple gaps |
| OSFI E-21 | Operational Resilience | No BCP for mobile |
| PCI DSS (if card data) | Not currently applicable | Monitor if payment features added |
| Proceeds of Crime Act | Audit trail for financial data | Sync history partial |

**Key banking requirements not yet met:**
1. Multi-factor authentication (biometric alone may not suffice -- need biometric + PIN)
2. Transaction signing for critical operations
3. Secure audit trail with tamper detection
4. Data loss prevention (DLP) for financial data
5. Regular penetration testing cadence
6. Vendor risk assessment for all third-party libraries

---

## 10. OWASP Mobile Top 10 Assessment

### M1 -- Improper Credential Usage
**Risk: HIGH**

| Finding | Severity |
|---------|----------|
| Odoo passwords stored plaintext in DB | High |
| SSH passwords/keys stored plaintext in DB | High |
| Debug keystore password hardcoded ("android") | Critical |
| Auto-login script injects credentials via string interpolation | Medium |
| `capacitor.config.json` contains keystore password | Critical |

### M2 -- Inadequate Supply Chain Security
**Risk: MEDIUM**

| Finding | Severity |
|---------|----------|
| External CDN script (`unpkg.com`) with `@latest` tag | Medium |
| No dependency vulnerability scanning (no npm audit in CI) | Medium |
| JSch 0.1.55 is unmaintained (last release 2018) | Medium |
| No SBOM (Software Bill of Materials) generation | Low |

### M3 -- Insecure Authentication/Authorization
**Risk: MEDIUM**

| Finding | Severity |
|---------|----------|
| No PIN fallback for biometric failure | Medium |
| No session timeout enforcement | Medium |
| No re-authentication for sensitive operations (delete server, export data) | Medium |
| No multi-factor authentication option | Medium |

### M4 -- Insufficient Input/Output Validation
**Risk: MEDIUM**

| Finding | Severity |
|---------|----------|
| Unsafe DOM injection in webViewUtils.ts | Medium |
| Credential injection in auto-login script | Medium |
| SQL queries use parameterized statements (good) | -- |
| HTML escaping in buildHtml() (good, but incomplete -- no `'` escaping) | Low |

### M5 -- Insecure Communication
**Risk: CRITICAL**

| Finding | Severity |
|---------|----------|
| `usesCleartextTraffic="true"` globally | Critical |
| SSH `StrictHostKeyChecking="no"` | Critical |
| No TLS certificate pinning | High |
| NTFY SSE without authentication | High |
| RawHttpPlugin disables CookieHandler globally | Medium |

### M6 -- Inadequate Privacy Controls
**Risk: HIGH**

| Finding | Severity |
|---------|----------|
| No privacy policy in app | High |
| No consent mechanism for data collection | High |
| No data export functionality | Medium |
| No data deletion (full wipe) functionality | Medium |
| Geolocation stored without explicit consent | High |

### M7 -- Insufficient Binary Protections
**Risk: HIGH**

| Finding | Severity |
|---------|----------|
| Vite minify disabled | High |
| ProGuard/R8 disabled | High |
| No root detection | Medium |
| No debugger detection | Medium |
| No anti-tampering | Medium |
| No code signing verification at runtime | Low |

### M8 -- Security Misconfiguration
**Risk: HIGH**

| Finding | Severity |
|---------|----------|
| Debug keystore in version control | Critical |
| `allowBackup="true"` in manifest | High |
| No network security config | High |
| Excessive permissions (deprecated storage) | Medium |
| No Content Security Policy | High |

### M9 -- Insecure Data Storage
**Risk: MEDIUM**

| Finding | Severity |
|---------|----------|
| Media files unencrypted on filesystem | Medium |
| Credentials plaintext in encrypted DB | High |
| Console logs may leak to logcat | Low |
| Database encryption key management is sound | -- |

### M10 -- Insufficient Cryptography
**Risk: LOW**

| Finding | Severity |
|---------|----------|
| SQLCipher AES-256 encryption (adequate) | -- |
| Key generation via crypto.getRandomValues (adequate) | -- |
| No secondary encryption for credentials | Medium |
| HTML escaping missing single-quote entity | Low |

---

## 11. Incident Response

### 11.1 Mobile-Specific Incident Scenarios

#### Scenario 1: Stolen/Lost Device
**Current risk: MEDIUM** (encrypted DB, but no remote wipe)

| Phase | Action |
|-------|--------|
| Preparation | Document device enrollment process |
| Detection | User reports lost device |
| Containment | Revoke Odoo session on server side |
| Eradication | Change all stored passwords (Odoo + SSH) |
| Recovery | Set up new device, restore from Odoo sync |
| Lessons | Consider MDM enrollment |

**Recommended controls:**
- Implement a "panic wipe" feature (accessible via wrong PIN N times)
- Support remote wipe via MDM (Mobile Device Management)
- Auto-lock after configurable inactivity timeout
- Clear clipboard after copying sensitive data

#### Scenario 2: Compromised Odoo Session
**Current risk: HIGH** (no token rotation, no anomaly detection)

| Phase | Action |
|-------|--------|
| Detection | Monitor for concurrent session usage on server |
| Containment | Invalidate session ID on Odoo server |
| Eradication | Force re-authentication in app |
| Recovery | Verify no unauthorized data changes |
| Lessons | Implement session anomaly detection |

**Recommended controls:**
- Bind session to device ID (Odoo server-side)
- Detect session hijacking via IP change
- Implement token rotation on each sync cycle

#### Scenario 3: Compromised SSH Credentials
**Current risk: CRITICAL** (SSH host key checking disabled)

| Phase | Action |
|-------|--------|
| Detection | Anomalous SSH access in server logs |
| Containment | Disable SSH key, change password |
| Eradication | Audit all actions taken via compromised session |
| Recovery | Re-key all affected servers |
| Lessons | Enable SSH host key verification |

#### Scenario 4: Supply Chain Attack (Compromised Dependency)
**Current risk: MEDIUM** (no dependency scanning)

| Phase | Action |
|-------|--------|
| Detection | Vulnerability advisory or anomalous behavior |
| Containment | Revert to known-good dependency versions |
| Eradication | Audit for data exfiltration |
| Recovery | Release patched build |
| Lessons | Implement automated dependency scanning |

### 11.2 Incident Response Plan Template

1. **Preparation**: Maintain a list of all data stored by the app and its sensitivity
2. **Detection**: Implement logging and anomaly detection (see Section 8.6)
3. **Containment**: Provide remote session revocation capability
4. **Eradication**: Document credential rotation procedures
5. **Recovery**: Ensure data can be restored from Odoo server sync
6. **Post-incident**: Update this security plan with lessons learned

---

## 12. CI/CD Security

### 12.1 Finding: Debug Keystore in Version Control
**Severity: CRITICAL**

The file `debug.keystore` (2730 bytes) is committed to the Git repository.
The `capacitor.config.json` contains the keystore password in plaintext:

```json
"android": {
    "buildOptions": {
        "releaseType": "APK",
        "keystorePath": "./../../debug.keystore",
        "keystorePassword": "android",
        "keystoreAlias": "android",
        "keystoreAliasPassword": "android"
    }
}
```

Additionally, `generate-keystore.sh` generates a keystore with the hardcoded
password "android".

**This means:**
- Anyone with repository access can sign APKs that appear to come from the official developer
- The debug keystore is used for what appears to be the release build configuration
- If this APK is distributed, any update signed with a different key will be rejected
  by Android, while any attacker can create a malicious update signed with the same key

**Recommendation:**
1. **Immediately** remove `debug.keystore` from version control and add it to `.gitignore`
2. Generate a proper release keystore with a strong password (32+ characters)
3. Store the release keystore and passwords in a secure secrets manager (e.g., GitHub
   Secrets, HashiCorp Vault, or a hardware security module)
4. Use separate keystores for debug and release builds
5. Rotate the keystore if the current one has been distributed
6. Move keystore configuration out of `capacitor.config.json` into environment variables
7. Consider Google Play App Signing to manage the upload key separately from the signing key

### 12.2 Finding: No Dependency Vulnerability Scanning
**Severity: Medium**

There is no evidence of automated dependency scanning:
- No `npm audit` in build scripts
- No Dependabot/Renovate configuration
- No Snyk or similar tool integration
- No SBOM generation

**Recommendation:**
- Add `npm audit --audit-level=high` to the CI pipeline
- Configure Dependabot or Renovate for automated dependency updates
- Generate SBOM (CycloneDX format) on each release
- Set up alerts for known vulnerabilities in dependencies
- Pin all dependency versions (replace `^` with exact versions in `package.json`)

### 12.3 Finding: JSch Library Is Unmaintained
**Severity: Medium**

`com.jcraft:jsch:0.1.55` (used in `SshPlugin.java`) was last released in 2018.
Known issues:
- No support for modern SSH key exchange algorithms
- No Ed25519 key support
- Multiple known vulnerabilities (CVE-2023-48795: Terrapin attack)

**Recommendation:**
- Migrate to `com.github.mwiede:jsch:0.2.x` (maintained fork of JSch)
  or `org.apache.sshd:sshd-core` (Apache MINA SSHD)
- Ensure the replacement library supports:
  - Ed25519 keys
  - ChaCha20-Poly1305 cipher
  - Modern key exchange algorithms
  - Proper host key verification

### 12.4 Build Pipeline Security Recommendations

| Control | Priority | Description |
|---------|----------|-------------|
| Reproducible builds | High | Pin all tool versions (Node, npm, Gradle, Android SDK) |
| Build isolation | High | Use containerized build environments |
| Artifact signing | High | Sign APKs with a proper release keystore in CI |
| Secret management | Critical | Move all secrets out of version control |
| Code signing verification | Medium | Verify signed commits in CI |
| SAST | Medium | Integrate static analysis (ESLint security plugin, MobSF) |
| DAST | Medium | Run MobSF dynamic analysis on built APKs |
| License scanning | Low | Verify all dependencies are AGPL-3.0+ compatible |

---

## 13. Prioritized Recommendations

### Phase 1 -- Critical (Immediate -- before any distribution)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 1 | Cleartext traffic enabled | Set `usesCleartextTraffic="false"`, add network security config | 2 hours |
| 2 | Debug keystore in VCS | Remove from repo, generate proper release keystore, add to `.gitignore` | 1 hour |
| 3 | Keystore password in capacitor.config.json | Move to environment variables or CI secrets | 1 hour |
| 4 | SSH host key checking disabled | Implement TOFU host key verification | 2 days |
| 5 | `allowBackup="true"` | Set to `false` or implement `EncryptedBackupAgent` | 30 minutes |

### Phase 2 -- High (Within 2 weeks)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 6 | Plaintext credentials in DB | Encrypt credential columns with secondary key | 3 days |
| 7 | No TLS certificate pinning | Implement network security config + TOFU pinning | 2 days |
| 8 | Vite minify disabled | Enable Terser for production, strip console.log | 1 hour |
| 9 | ProGuard/R8 disabled | Enable R8 with proper keep rules | 2 days |
| 10 | No CSP | Add Content Security Policy meta tag | 1 hour |
| 11 | NTFY unauthenticated | Add Bearer token authentication | 1 day |
| 12 | External CDN script | Vendor `@ionic/pwa-elements` locally | 1 hour |
| 13 | No dependency scanning | Add npm audit to CI, configure Dependabot | 2 hours |
| 14 | JSch unmaintained | Migrate to maintained fork (mwiede/jsch) | 1 day |

### Phase 3 -- Medium (Within 1 month)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 15 | No PIN fallback | Implement secure PIN entry with lockout | 3 days |
| 16 | No session timeout | Add configurable session expiry | 1 day |
| 17 | Media files unencrypted | Implement file-level encryption | 3 days |
| 18 | No privacy policy | Draft bilingual privacy policy | 2 days |
| 19 | No consent mechanism | Add consent dialogs for geolocation/camera/mic | 2 days |
| 20 | Credential injection in login script | Sanitize credentials before script injection | 4 hours |
| 21 | Unsafe DOM injection in webViewUtils | Remove dead code path | 30 minutes |
| 22 | Deprecated storage permissions | Remove, use scoped storage | 1 day |
| 23 | Root/debugger detection | Implement basic integrity checks | 2 days |
| 24 | Data export/erasure | Implement for PIPEDA/GDPR compliance | 3 days |
| 25 | RawHttpPlugin thread safety | Migrate to OkHttp or add synchronization | 2 days |

### Phase 4 -- Low/Enhancement (Within 3 months)

| # | Finding | Action | Effort |
|---|---------|--------|--------|
| 26 | No SBOM generation | Integrate CycloneDX into CI | 2 hours |
| 27 | No penetration testing | Commission external pentest | External |
| 28 | No DPIA | Conduct Data Protection Impact Assessment | 3 days |
| 29 | No MDM support | Evaluate MDM integration for enterprise | 2 weeks |
| 30 | Session anomaly detection | Bind sessions to device ID | 2 days |
| 31 | Secure audit trail | Implement tamper-evident logging | 3 days |
| 32 | Advanced anti-tampering | Evaluate DexGuard or similar | External |

---

## 14. Risk Register

| ID | Risk | Likelihood | Impact | Score | Mitigation | Status |
|----|------|-----------|--------|-------|------------|--------|
| R-01 | MITM attack on cleartext HTTP traffic | High | Critical | **Critical** | Disable cleartext traffic, enforce HTTPS | Open |
| R-02 | APK signing key compromise via committed keystore | High | Critical | **Critical** | Remove from VCS, proper key management | Open |
| R-03 | SSH MITM via disabled host key verification | Medium | Critical | **Critical** | Implement TOFU host key verification | Open |
| R-04 | Credential theft from encrypted DB via root exploit | Medium | High | **High** | Secondary encryption with biometric binding | Open |
| R-05 | Session hijacking via no cert pinning | Medium | High | **High** | Implement certificate pinning | Open |
| R-06 | Supply chain attack via CDN script | Low | Critical | **High** | Vendor dependencies locally | Open |
| R-07 | NTFY notification spoofing | Medium | Medium | **Medium** | Implement NTFY authentication | Open |
| R-08 | Reverse engineering via unobfuscated code | High | Medium | **Medium** | Enable minification and R8 | Open |
| R-09 | Stolen device data extraction | Medium | High | **High** | Auto-lock, remote wipe, PIN fallback | Open |
| R-10 | Privacy violation (PIPEDA/GDPR) | Medium | High | **High** | Privacy policy, consent, data portability | Open |
| R-11 | Known vulnerability in JSch 0.1.55 | Medium | High | **High** | Migrate to maintained SSH library | Open |
| R-12 | XSS via unsafe DOM injection in webViewUtils | Low | Medium | **Medium** | Remove dead code path | Open |
| R-13 | Android backup data extraction | Medium | Medium | **Medium** | Disable backups or encrypt | Open |
| R-14 | Information disclosure via console.log | Low | Low | **Low** | Strip console in production | Open |
| R-15 | Denial of service via unrated NTFY triggers | Low | Medium | **Low** | Rate-limit sync triggers | Open |

---

## 15. Implementation Roadmap

```
Week 1 (CRITICAL)
    |-- Day 1-2: Remove keystore from VCS, disable cleartext traffic
    |-- Day 2-3: Add network_security_config.xml
    |-- Day 3-5: Implement SSH host key TOFU verification
    |-- Day 5:   Disable android:allowBackup, enable minification

Week 2-3 (HIGH)
    |-- Credential encryption migration (new DB migration)
    |-- TLS certificate TOFU pinning
    |-- Enable R8/ProGuard for release builds
    |-- Add CSP, vendor CDN scripts
    |-- Add npm audit to build, migrate JSch

Week 4-6 (MEDIUM)
    |-- PIN fallback authentication
    |-- Session timeout enforcement
    |-- Media file encryption
    |-- Privacy policy + consent flows
    |-- Root/debugger detection
    |-- Data export/erasure features

Week 7-12 (ENHANCEMENT)
    |-- SBOM generation
    |-- External penetration test
    |-- DPIA completion
    |-- MDM evaluation
    |-- Advanced anti-tampering
    |-- Secure audit trail
```

---

## Appendix A: Threat Model (STRIDE)

| Threat | Category | Asset | Mitigation |
|--------|----------|-------|------------|
| Attacker intercepts HTTP traffic | Spoofing, Tampering, Info Disclosure | Credentials, session IDs, note data | Disable cleartext, enforce HTTPS, cert pinning |
| Attacker impersonates SSH server | Spoofing | SSH credentials | TOFU host key verification |
| Attacker extracts data from stolen device | Information Disclosure | All local data | PIN/biometric, encryption, remote wipe |
| Attacker decompiles APK | Information Disclosure | Business logic, API endpoints | Minification, R8, anti-tampering |
| Attacker exploits known CVE in JSch | Elevation of Privilege | SSH sessions | Update to maintained library |
| Attacker signs malicious APK with committed keystore | Spoofing | App identity | Remove keystore from VCS |
| Attacker exploits unsafe DOM injection | Tampering, Elevation of Privilege | WebView context | Remove dead code, add CSP |
| Attacker reads NTFY topic | Information Disclosure | Notification content | NTFY authentication |
| Attacker triggers sync via NTFY | Denial of Service | Sync service availability | Rate limiting, message validation |
| Rooted device extracts encryption key | Information Disclosure | All encrypted data | Biometric-bound Keystore key |

## Appendix B: Dependency Inventory (Security-Relevant)

| Package | Version | Risk Notes |
|---------|---------|------------|
| `@capacitor/core` | ^8.0.0 | Core framework -- keep updated |
| `@aparajita/capacitor-biometric-auth` | ^10.0.0 | Biometric API wrapper |
| `capacitor-secure-storage-plugin` | ^0.13.0 | Critical -- stores encryption keys |
| `@capacitor-community/sqlite` | ^8.0.0 | SQLCipher wrapper -- critical |
| `@capgo/inappbrowser` | ^8.5.0 | WebView -- potential XSS vector |
| `com.jcraft:jsch:0.1.55` | 0.1.55 | **UNMAINTAINED** -- CVE-2023-48795 |
| `com.google.mlkit:text-recognition` | 16.0.1 | ML Kit OCR -- Google dependency |
| `@ionic/pwa-elements` | @latest (CDN) | **UNPINNED** -- supply chain risk |
| `sortablejs` | ^1.15.6 | DOM manipulation library |
| `uuid` | ^13.0.0 | ID generation -- uses crypto.getRandomValues |

## Appendix C: Compliance Checklist

### PIPEDA Quick-Check

- [ ] Privacy policy accessible in-app (EN + FR)
- [ ] Consent obtained before collecting geolocation
- [ ] Consent obtained before accessing camera
- [ ] Consent obtained before accessing microphone
- [ ] Data retention periods documented
- [ ] Data export functionality implemented
- [ ] Data deletion functionality implemented
- [ ] Security safeguards documented
- [ ] Breach notification procedure documented
- [ ] Data Protection Officer designated

### GDPR Quick-Check

- [ ] Lawful basis documented for each processing activity
- [ ] Data Protection Impact Assessment completed
- [ ] Privacy notice compliant with Art. 13/14
- [ ] Right of access implemented (Art. 15)
- [ ] Right to erasure implemented (Art. 17)
- [ ] Right to data portability implemented (Art. 20)
- [ ] Data processing records maintained (Art. 30)
- [ ] Sub-processor agreements in place (Odoo hosting, NTFY)
- [ ] Cross-border transfer safeguards (if EU data leaves Canada)

---

*This security plan should be reviewed and updated quarterly, or immediately upon
any significant architecture change, new feature addition, or security incident.*

*Next review date: 2026-07-14*
