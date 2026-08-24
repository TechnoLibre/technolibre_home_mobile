<!---------------------------->
<!-- multilingual suffix: en, fr -->
<!-- no suffix: en -->
<!---------------------------->

<!-- [en] -->
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

<!-- [fr] -->
# ERPLibre Home Mobile -- Plan de sécurité complet

**Date** : 2026-04-14
**Version** : 1.0.0
**Classification** : CONFIDENTIEL -- usage interne uniquement
**Licence** : AGPL-3.0+
**Posture visée** : application mobile de niveau bancaire

---

## Table des matières

1. [Résumé pour la direction](#1-résumé-pour-la-direction)
2. [Portée et méthodologie](#2-portée-et-méthodologie)
3. [Évaluation de l'état actuel](#3-évaluation-de-létat-actuel)
4. [Authentification et autorisation](#4-authentification-et-autorisation)
5. [Protection des données](#5-protection-des-données)
6. [Stockage sécurisé](#6-stockage-sécurisé)
7. [Sécurité réseau](#7-sécurité-réseau)
8. [Sécurité du code](#8-sécurité-du-code)
9. [Conformité -- PIPEDA, RGPD, secteur bancaire](#9-conformité----pipeda-rgpd-secteur-bancaire)
10. [Évaluation OWASP Mobile Top 10](#10-évaluation-owasp-mobile-top-10)
11. [Réponse aux incidents](#11-réponse-aux-incidents)
12. [Sécurité de la chaîne CI/CD](#12-sécurité-de-la-chaîne-cicd)
13. [Recommandations priorisées](#13-recommandations-priorisées)
14. [Registre des risques](#14-registre-des-risques)
15. [Feuille de route de mise en œuvre](#15-feuille-de-route-de-mise-en-œuvre)

---

## 1. Résumé pour la direction

ERPLibre Home Mobile est une application Capacitor 8 / Owl 2.8.1 / TypeScript visant
Android (et à terme iOS), qui offre la prise de notes, la synchronisation avec l'ERP Odoo,
la gestion de serveurs SSH et la transcription audio sur l'appareil. L'application est
positionnée pour des déploiements de niveau bancaire, connectés à des instances Odoo
financières.

Ce plan de sécurité est le fruit d'une analyse coordonnée par sept rôles spécialisés :
**system-architect**, **security-specialist**, **compliance-specialist**,
**data-governance**, **risk-manager**, **penetration-tester** et
**legal-license-advisor**. Chaque rôle a analysé indépendamment le code source actuel sous
`/home/leo/erplibre01/mobile/erplibre_home_mobile/` et produit des constats qui ont été
recoupés pour former ce plan unifié.

**Évaluation globale** : l'application repose sur des *fondations solides* dans plusieurs
domaines (SQLite chiffré avec la clé dans SecureStorage, verrou biométrique, requêtes SQL
paramétrées, usage du SecureStoragePlugin de Capacitor). Il subsiste toutefois plusieurs
manques de gravité **critique** et **élevée** à combler avant que l'application puisse
satisfaire des exigences de sécurité de niveau bancaire. Les points les plus urgents sont :
le trafic en clair activé globalement, le keystore de debug versionné avec un mot de passe
en dur, la vérification de la clé d'hôte SSH désactivée, l'absence d'épinglage de
certificat TLS, des identifiants stockés en clair dans la base chiffrée, et l'absence
d'obfuscation du code comme de mesures anti-altération.

---

## 2. Portée et méthodologie

### 2.1 Fichiers analysés

| Catégorie | Fichiers clés |
|-----------|---------------|
| Configuration de l'app | `capacitor.config.json`, `package.json`, `vite.config.ts` |
| Natif Android | `AndroidManifest.xml`, `build.gradle`, `MainActivity.java` |
| Plugins natifs | `SshPlugin.java`, `RawHttpPlugin.java`, `NetworkScanPlugin.java`, `WhisperPlugin.java`, `OcrPlugin.java` |
| Authentification | `biometryUtils.ts`, `storageUtils.ts` |
| Base de données | `databaseService.ts`, `migrationService.ts` |
| Réseau et synchro | `syncService.ts`, `ntfyService.ts`, `notificationService.ts`, `rawHttpPlugin.ts` |
| Gestion de serveurs | `serverService.ts`, `deploymentService.ts`, `sshPlugin.ts` |
| Modèles | `application.ts`, `server.ts`, `syncConfig.ts` |
| Scripts de compilation | `generate-keystore.sh`, `build-android.sh` |
| Environnement | `.env.production`, `.env.staging` |

### 2.2 Méthodologie

- Analyse statique de tous les fichiers source TypeScript et Java
- Revue de configuration du manifeste Android, de Gradle, de Capacitor et de Vite
- Inventaire des dépendances depuis `package.json`
- Correspondance avec l'OWASP Mobile Top 10 (2024)
- Recoupement PIPEDA / RGPD / réglementation bancaire canadienne
- Modélisation des menaces selon la méthode STRIDE

---

## 3. Évaluation de l'état actuel

### 3.1 Ce qui est déjà bien fait

| Contrôle | État | Notes |
|----------|------|-------|
| Chiffrement SQLite (SQLCipher) | Mis en œuvre | Clé aléatoire de 256 bits générée par `crypto.getRandomValues()` |
| Clé de chiffrement dans SecureStorage | Mis en œuvre | Clé stockée dans le SecureStoragePlugin adossé à l'Android Keystore |
| Authentification biométrique | Mis en œuvre | Verrouille l'accès à la base au démarrage de l'app |
| Requêtes SQL paramétrées | Mis en œuvre | Toutes les méthodes de la base utilisent des `?`, aucune interpolation de chaîne |
| Session stockée dans SecureStorage | Mis en œuvre | Identifiants de session Odoo persistés via SecureStoragePlugin |
| Système de migration de schéma | Mis en œuvre | Estampillé en CalVer, idempotent, avec suivi de l'historique |
| Politique de sécurité du contenu | Partiel | `user-scalable=no` est posé (bloque les attaques par zoom) |

### 3.2 Synthèse des manques critiques

| Manque | Gravité | Section |
|--------|---------|---------|
| `android:usesCleartextTraffic="true"` dans le manifeste | **Critique** | 7.1 |
| Keystore de debug versionné avec le mot de passe en dur « android » | **Critique** | 12.1 |
| `StrictHostKeyChecking` SSH réglé à « no » | **Critique** | 7.4 |
| Mots de passe Odoo stockés en colonnes claires dans la base chiffrée | **Élevée** | 5.2 |
| Mots de passe et clés privées SSH stockés en clair dans la base chiffrée | **Élevée** | 5.2 |
| Aucun épinglage de certificat TLS | **Élevée** | 7.2 |
| `minify: false` de Vite en compilation de production | **Élevée** | 8.1 |
| `minifyEnabled false` côté Android (ni ProGuard ni R8) | **Élevée** | 8.2 |
| Aucun en-tête de politique de sécurité du contenu | **Élevée** | 8.3 |
| SSE NTFY sur connexion non authentifiée | **Élevée** | 7.5 |
| Injection DOM non sûre dans webViewUtils.ts | **Moyenne** | 8.4 |
| Le script d'auto-remplissage injecte les identifiants par interpolation de chaîne | **Moyenne** | 4.5 |
| Aucune analyse de vulnérabilité des dépendances | **Moyenne** | 12.2 |
| Script CDN externe dans `index.html` (unpkg.com) | **Moyenne** | 8.5 |
| Permissions Android excessives | **Moyenne** | 7.6 |
| La bibliothèque JSch (0.1.55) n'est plus maintenue et est vulnérable | **Moyenne** | 12.3 |
| Aucune expiration de session imposée | **Moyenne** | 4.3 |
| `console.log` peut divulguer des données sensibles en production | **Faible** | 8.6 |

---

## 4. Authentification et autorisation

### 4.1 Architecture d'authentification actuelle

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

**Flux d'authentification Odoo :**
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

### 4.2 Constat : aucun repli par NIP pour l'authentification biométrique
**Gravité : moyenne**

Le contrôle biométrique de `biometryUtils.ts` n'offre aucun repli par NIP ou schéma. Si le
matériel biométrique défaille ou que l'empreinte de l'utilisateur n'est pas reconnue,
l'application affiche « Authentification biometrique echouee. Relancez l'application. » et
devient inaccessible. C'est un problème d'ergonomie et de disponibilité.

**Recommandation :**
- Mettre en place une saisie de NIP sécurisée (6 chiffres ou plus) en repli de l'échec biométrique
- Stocker l'empreinte du NIP (bcrypt/Argon2) dans SecureStorage
- Limiter les tentatives de NIP (5 essais, puis attente exponentielle)
- Envisager `setDeviceCredentialAllowed(true)` d'Android pour autoriser le NIP ou le schéma de l'appareil

### 4.3 Constat : aucune expiration de session imposée
**Gravité : moyenne**

L'identifiant de session Odoo stocké dans SecureStorage n'a aucune expiration locale.
L'application s'appuie entièrement sur l'expiration côté serveur d'Odoo. Si une session est
compromise, elle reste valide jusqu'à ce que le serveur l'expire.

**Recommandation :**
- Stocker l'horodatage de création à côté de l'identifiant de session
- Imposer un âge maximal de session (configurable, 24 heures par défaut)
- Forcer une réauthentification après N minutes d'arrière-plan
- Effacer les sessions lors d'un réenrôlement biométrique

### 4.4 Constat : aucun modèle d'autorisation pour les données locales
**Gravité : faible**

Toutes les données de la base SQLite sont accessibles dès que la clé de chiffrement est
obtenue. Il n'existe aucun contrôle d'accès par ligne ou par table distinguant les
différentes connexions à des serveurs Odoo.

**Recommandation (pour les déploiements multi-locataires) :**
- Envisager une segmentation de la base par serveur
- Étiqueter toutes les lignes d'un `server_id` en prévision d'un contrôle d'accès
- Priorité plus faible, sauf si des scénarios multi-utilisateurs sont prévus

### 4.5 Constat : injection d'identifiants dans le script d'auto-connexion
**Gravité : moyenne**

Dans `applications_component.ts` (vers les lignes 418-419), le script d'auto-connexion du
navigateur intégré injecte les identifiants par interpolation de chaîne JavaScript :

```
setInputValue(userEl, "${matchingApp.username}");
setInputValue(passEl, "${matchingApp.password}");
```

Si un nom d'utilisateur ou un mot de passe contient un `"`, un `\` ou un accent grave, cela
peut casser le script ou permettre une injection dans le contexte de la WebView.

**Recommandation :**
- Échapper les identifiants avant de les injecter dans la chaîne du script
- Employer un mécanisme d'injection plus sûr (p. ex. `postMessage` du natif vers la WebView)
- Envisager `WebView.evaluateJavascript()` de Capacitor avec une liaison de paramètres correcte

---

## 5. Protection des données

### 5.1 Classification des données

| Type de donnée | Classification | Protection actuelle | Protection requise |
|----------------|---------------|--------------------|--------------------|
| Clé de chiffrement SQLite | **SECRÈTE** | SecureStorage (adossé au Keystore) | Adéquate |
| État d'enrôlement biométrique | **INTERNE** | SecureStorage | Adéquate |
| Identifiants de session Odoo | **CONFIDENTIELS** | SecureStorage | Adéquate |
| Mots de passe Odoo | **SECRETS** | En clair dans la base chiffrée | Chiffrement supplémentaire nécessaire |
| Mots de passe SSH | **SECRETS** | En clair dans la base chiffrée | Chiffrement supplémentaire nécessaire |
| Clés privées SSH | **SECRÈTES** | En clair dans la base chiffrée | Chiffrement supplémentaire nécessaire |
| Phrases de passe SSH | **SECRÈTES** | En clair dans la base chiffrée | Chiffrement supplémentaire nécessaire |
| URL et sujets NTFY | **INTERNES** | En clair dans la base chiffrée | Adéquate |
| Contenu des notes (texte) | **CONFIDENTIEL** | Base chiffrée | Adéquate |
| Contenu des notes (photos/vidéos) | **CONFIDENTIEL** | Système de fichiers (non chiffré) | Chiffrement nécessaire |
| Données de géolocalisation | **CONFIDENTIELLES** | Base chiffrée | Adéquate |
| Enregistrements audio | **CONFIDENTIELS** | Système de fichiers (non chiffré) | Chiffrement nécessaire |
| Binaires des modèles Whisper | **PUBLICS** | Système de fichiers | Adéquate |
| Version de schéma | **INTERNE** | SecureStorage | Adéquate |
| Historique des migrations | **INTERNE** | SecureStorage | Adéquate |

### 5.2 Constat : identifiants en clair dans la base chiffrée
**Gravité : élevée**

La table `applications` stocke les mots de passe Odoo dans une colonne `password TEXT` en
clair. La table `servers` stocke les mots de passe SSH, les clés privées et les phrases de
passe dans des colonnes en clair. La base est certes chiffrée par SQLCipher, mais cela ne
constitue qu'une seule couche de défense. Si la clé de chiffrement est compromise (par un
exploit root ou un vidage mémoire, par exemple), tous les identifiants sont immédiatement
exposés.

**Schéma actuel (applications) :**
```sql
CREATE TABLE applications (
    url TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,           -- PLAINTEXT
    PRIMARY KEY (url, username)
)
```

**Schéma actuel (servers) :**
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

**Recommandation :**
- Chiffrer les champs d'identifiants avec une clé secondaire dérivée de la biométrie ou du NIP de l'utilisateur
- Employer AES-256-GCM avec un IV aléatoire par identifiant
- Stocker la clé secondaire dans l'Android Keystore avec liaison biométrique
  (`setUserAuthenticationRequired(true)`)
- En variante, déplacer tous les identifiants dans SecureStorage (adossé au Keystore) et
  ne conserver que des références en base

### 5.3 Constat : fichiers médias stockés non chiffrés sur le système de fichiers
**Gravité : moyenne**

Les photos, vidéos et enregistrements audio référencés par les entrées de note sont stockés
sur le système de fichiers Android sans chiffrement. Sur un appareil rooté, ces fichiers
sont directement accessibles.

**Recommandation :**
- Employer Filesystem de Capacitor pour écrire les médias dans le stockage interne de l'app (`Directory.Data`)
- Mettre en place un chiffrement au niveau du fichier avec AES-256-GCM avant l'écriture
- Stocker la clé de chiffrement des fichiers dans SecureStorage
- Supprimer les fichiers temporaires en clair après chiffrement
- Envisager les API de système de fichiers chiffré d'Android (EncryptedFile de Jetpack Security)

### 5.4 Politique de conservation des données

Aucune politique de conservation n'est actuellement en place. Pour la conformité
PIPEDA/RGPD :

- **Notes** : conserver jusqu'à suppression explicite par l'utilisateur. Offrir un export puis une suppression en masse
- **Identifiants** : expirer après une période configurable (90 jours par défaut)
- **Identifiants de session** : expirer après 24 heures au maximum
- **Données de géolocalisation** : avertir l'utilisateur ; offrir de les retirer des données synchronisées
- **Enregistrements audio** : offrir une suppression automatique après transcription
- **Historique de synchronisation** : conserver 90 jours au maximum, puis purger automatiquement
- **Journaux de processus** : conserver 30 jours au maximum (ils peuvent contenir des données de débogage)

---

## 6. Stockage sécurisé

### 6.1 Architecture actuelle

```
SecureStoragePlugin (capacitor-secure-storage-plugin v0.13.0)
    |
    +--> Android: EncryptedSharedPreferences
    |       +--> Master key in Android Keystore (hardware-backed where available)
    |
    +--> iOS: Keychain (when iOS is added)
```

**Éléments actuellement dans SecureStorage :**
- `db_encryption_key` -- chaîne hexadécimale de 256 bits
- `biometry_enabled` -- drapeau booléen
- `odoo_sync_session_*` -- données de session par serveur
- `schema_version` -- entier
- `migration_history` -- tableau JSON
- `odoo_sync_config` / `odoo_sync_configs` -- configuration de synchronisation
- `dev_mode_unlocked` -- drapeau de débogage

### 6.2 Constat : version du plugin SecureStorage
**Gravité : faible**

`capacitor-secure-storage-plugin` v0.13.0 est utilisé. Il s'agit d'un plugin
communautaire. Vérifier qu'il emploie bien `EncryptedSharedPreferences` (Jetpack Security)
sur Android, qui fournit AES-256-SIV pour les clés et AES-256-GCM pour les valeurs, adossés
à l'Android Keystore.

**Recommandation :**
- Auditer le code du plugin pour confirmer l'adossement au Keystore sur les versions d'Android visées
- Envisager StrongBox Keymaster (`setIsStrongBoxBacked(true)`) pour un adossement à un
  module matériel de sécurité (HSM) là où c'est possible
- Figer la version du plugin dans `package.json` (actuellement `^0.13.0`, ce qui autorise
  une dérive de version mineure)

### 6.3 Constat : génération de la clé de chiffrement
**Gravité : faible -- actuellement adéquat**

La clé de chiffrement est correctement générée par `crypto.getRandomValues(32)` (256 bits
issus d'un CSPRNG). La clé est persistée dans SecureStorage au premier usage puis réutilisée
ensuite. C'est un bon patron.

**Recommandation pour un renforcement de niveau bancaire :**
- Lier la clé de chiffrement à l'authentification biométrique via
  `setUserAuthenticationRequired(true)` de l'Android Keystore, avec
  `setUserAuthenticationValidityDurationSeconds(0)` (biométrie exigée à chaque usage)
- Cela empêche l'extraction de la clé même si l'appareil est rooté pendant qu'il est verrouillé

---

## 7. Sécurité réseau

### 7.1 Constat : trafic en clair activé globalement
**Gravité : CRITIQUE**

`AndroidManifest.xml`, ligne 11 :
```xml
android:usesCleartextTraffic="true"
```

Cela autorise les communications HTTP (sans TLS) pour toutes les requêtes réseau. Dans une
application de niveau bancaire, cela expose toutes les données à une interception réseau
(MITM) : identifiants Odoo, identifiants de session, contenu des notes et identifiants SSH
transmis par le service de synchronisation.

**Traces d'usage en clair dans le code :**
- `normalizeUrl()` de `syncService.ts` retient `https://` par défaut mais accepte `http://`
- `RawHttpPlugin.java` emploie `HttpURLConnection`, qui suit le réglage du manifeste
- `ntfyService.ts` se connecte à des URL fournies par l'utilisateur sans imposer de protocole

**Recommandation :**
- Poser `android:usesCleartextTraffic="false"` dans AndroidManifest.xml
- Ajouter une configuration de sécurité réseau (`res/xml/network_security_config.xml`) qui :
  - refuse globalement le trafic en clair
  - autorise éventuellement le clair pour `localhost` / `10.0.2.2` en compilation de débogage seulement
- Imposer HTTPS dans `normalizeUrl()` de `syncService.ts` — rejeter entièrement les URL `http://`
- Imposer HTTPS pour les connexions NTFY
- Afficher un avertissement visible dans l'interface quand l'utilisateur saisit une URL HTTP

### 7.2 Constat : aucun épinglage de certificat TLS
**Gravité : élevée**

Aucun épinglage de certificat n'est mis en œuvre nulle part dans l'application.
L'application fait confiance à l'ensemble du magasin de certificats du système, ce qui la
rend vulnérable à :
- des autorités de certification compromises
- un MITM par mandataire d'entreprise (courant en déploiement professionnel)
- une injection de certificat commanditée par un État

**Recommandation :**
- Mettre en œuvre l'épinglage de certificat dans `network_security_config.xml` pour les serveurs Odoo connus
- Pour les serveurs Odoo configurés par l'utilisateur : mettre en œuvre un épinglage à la première connexion (TOFU)
  - À la première connexion, stocker l'empreinte du certificat du serveur dans SecureStorage
  - Aux connexions suivantes, vérifier que l'empreinte correspond
  - Alerter l'utilisateur si le certificat change
- Envisager OkHttp avec CertificatePinner pour le plugin HTTP natif

### 7.3 Constat : RawHttpPlugin contourne la sécurité des témoins
**Gravité : moyenne -- compromis d'architecture**

`RawHttpPlugin.java` pose temporairement `CookieHandler.setDefault(null)` pour contourner la
gestion des témoins d'Android. Cela résout le problème de livraison du session_id sur les
connexions HTTP vers des adresses IP, mais :
- désactive la sécurité des témoins pour toutes les connexions concurrentes pendant la requête
- n'est pas sûr en contexte multithread (un autre fil pourrait émettre une requête pendant la fenêtre nulle)

**Recommandation :**
- Employer `OkHttpClient` plutôt que `HttpURLConnection` — OkHttp ne souffre pas de
  l'interférence du CookieHandler
- Régler la gestion des témoins par connexion plutôt que de manipuler le gestionnaire global
- Ajouter un bloc synchronisé ou un ReentrantLock autour de l'échange de gestionnaire si la
  migration vers OkHttp n'est pas immédiate

### 7.4 Constat : vérification de la clé d'hôte SSH désactivée
**Gravité : CRITIQUE**

`SshPlugin.java`, lignes 57-58 :
```java
config.put("StrictHostKeyChecking", "no");
session.setConfig(config);
```

Cela désactive complètement la vérification de la clé d'hôte SSH, ce qui rend la connexion
SSH vulnérable aux attaques de l'homme du milieu. Un attaquant sur le réseau peut se faire
passer pour n'importe quel serveur SSH et capturer les identifiants (mots de passe, clés
privées) transmis pendant l'authentification.

**C'est d'autant plus critique que le plugin SSH sert à :**
- l'administration de serveurs distants (accès root/sudo)
- le déploiement d'ERPLibre (installation de logiciels sur des serveurs de production)
- l'exécution de commandes arbitraires sur des machines distantes

**Recommandation :**
- Mettre en place un magasin known_hosts dans SecureStorage ou dans la base chiffrée
- À la première connexion à un nouvel hôte : afficher l'empreinte du serveur et exiger la
  confirmation de l'utilisateur (confiance à la première utilisation)
- Aux connexions suivantes : vérifier que l'empreinte correspond à la valeur stockée
- Si l'empreinte change : afficher un avertissement bien visible et exiger une approbation
  explicite de l'utilisateur
- Remplacer JSch par Apache MINA SSHD ou sshj, qui offrent de meilleures API de vérification
  de clé d'hôte
- Afficher l'empreinte de la clé d'hôte dans l'interface de configuration du serveur

### 7.5 Constat : le service NTFY emploie du SSE non authentifié
**Gravité : élevée**

`ntfyService.ts` se connecte au serveur NTFY par `EventSource` (Server-Sent Events) sans
aucune authentification. Quiconque connaît le nom du sujet peut :
- s'abonner et lire toutes les notifications (divulgation d'information)
- publier des messages qui déclenchent des synchronisations (déclenchement non autorisé)

**Recommandation :**
- Prendre en charge les jetons d'authentification NTFY (Bearer ou authentification de base)
- Stocker le jeton d'authentification NTFY dans SecureStorage
- Employer des listes de contrôle d'accès NTFY côté serveur
- Valider les messages NTFY entrants (signature de message ou HMAC)
- Limiter la cadence des déclenchements de synchronisation depuis NTFY pour prévenir un déni de service

### 7.6 Constat : permissions Android excessives
**Gravité : moyenne**

Permissions actuelles dans AndroidManifest.xml :
- `INTERNET` -- requise
- `WAKE_LOCK` -- requise (téléchargements de modèles)
- `FOREGROUND_SERVICE` -- requise
- `FOREGROUND_SERVICE_DATA_SYNC` -- requise
- `POST_NOTIFICATIONS` -- requise
- `ACCESS_COARSE_LOCATION` -- à revoir : la localisation grossière est-elle nécessaire en plus de la fine ?
- `ACCESS_FINE_LOCATION` -- requise pour les entrées de géolocalisation
- `RECORD_AUDIO` -- requise pour l'enregistrement vocal
- `READ_EXTERNAL_STORAGE` -- dépréciée à partir de l'API 33, nécessité à revoir
- `WRITE_EXTERNAL_STORAGE` -- dépréciée à partir de l'API 33, nécessité à revoir

**Recommandation :**
- Retirer `READ_EXTERNAL_STORAGE` et `WRITE_EXTERNAL_STORAGE` — employer plutôt les API de
  stockage cloisonné (obligatoires à partir de l'API 30)
- Retirer `ACCESS_COARSE_LOCATION` — seule `ACCESS_FINE_LOCATION` est nécessaire
- Ajouter `android:maxSdkVersion="32"` aux permissions de stockage si la compatibilité
  descendante est requise
- Demander les permissions à l'exécution seulement quand la fonctionnalité concernée est
  utilisée (les plugins Capacitor le font déjà, mais à vérifier)

### 7.7 Constat : le plugin de scan réseau expose la topologie du réseau local
**Gravité : moyenne**

`NetworkScanPlugin.java` scanne tout le sous-réseau /24 à la recherche de services SSH.
C'est utile pour découvrir des serveurs, mais cela :
- expose la topologie du réseau local à l'application
- pourrait servir à du code malveillant (si la WebView est compromise) pour cartographier des réseaux internes
- peut déclencher des alertes IDS/IPS en environnement d'entreprise

**Recommandation :**
- Conditionner le scan réseau à une action explicite de l'utilisateur, avec un dialogue d'avertissement
- Journaliser l'activité de scan dans l'historique des processus
- Envisager de restreindre le scan à des plages d'adresses indiquées par l'utilisateur
- Ajouter un interrupteur de permission de scan réseau dans les réglages

---

## 8. Sécurité du code

### 8.1 Constat : la compilation de production Vite n'est pas minifiée
**Gravité : élevée**

`vite.config.ts`, ligne 7 :
```typescript
minify: false,
```

La compilation de production inclut dans l'APK du JavaScript non minifié et lisible par un
humain. La rétro-ingénierie en devient triviale — tous les noms de variables, de fonctions,
les commentaires et la logique sont préservés.

**Recommandation :**
- Poser `minify: 'terser'` ou `minify: 'esbuild'` pour les compilations de production
- Configurer Terser pour brouiller les noms de variables et retirer les commentaires
- Ne garder `minify: false` que dans les configurations de développement et de préproduction

### 8.2 Constat : ProGuard/R8 désactivé côté Android
**Gravité : élevée**

`android/app/build.gradle`, ligne 27 :
```gradle
minifyEnabled false
```

Le code Java/Kotlin de l'APK n'est pas obfusqué. Combiné au JavaScript non minifié, toute la
logique de l'application est transparente pour quiconque dispose d'un décompilateur d'APK
(jadx, apktool).

**Recommandation :**
- Activer R8 pour les compilations de publication, avec `minifyEnabled true` et `shrinkResources true`
- Ajouter des règles ProGuard pour Capacitor, JSch et ML Kit afin d'éviter les plantages à l'exécution
- Tester soigneusement après activation (R8 peut casser du code fondé sur la réflexion)

### 8.3 Constat : aucune politique de sécurité du contenu
**Gravité : élevée**

`index.html` ne porte ni balise meta Content-Security-Policy ni en-tête HTTP. La WebView peut
charger et exécuter des scripts depuis n'importe quelle origine.

**Recommandation :**
- Ajouter une balise meta CSP à `index.html`, restreignant script-src, connect-src et object-src
- Bloquer l'exécution de code dynamique via `script-src` (ne pas inclure `'unsafe-eval'`)
- À noter : `'unsafe-inline'` peut être nécessaire pour la compilation des gabarits d'Owl

### 8.4 Constat : injection DOM non sûre dans webViewUtils.ts
**Gravité : moyenne**

`webViewUtils.ts`, ligne 53, emploie une manipulation du DOM non sûre pour injecter le
contenu d'un script. Le code porte un commentaire `// TODO not working the injection, not
secure` qui reconnaît le problème. Ce patron ouvre la porte à du XSS si le paramètre `script`
contient du contenu contrôlé par un attaquant.

**Recommandation :**
- Retirer entièrement ce chemin de code (il est marqué comme non fonctionnel)
- Employer `textContent` plutôt qu'une affectation de propriété DOM non sûre pour les éléments de script
- Si une injection dans la WebView de bureau est nécessaire, employer une approche conforme à la CSP

### 8.5 Constat : dépendance à un script CDN externe
**Gravité : moyenne**

`index.html`, lignes 14-20, charge des scripts depuis `unpkg.com` à l'exécution avec
l'étiquette `@latest` :

Charger des scripts depuis un CDN externe à l'exécution :
- crée un vecteur d'attaque sur la chaîne d'approvisionnement (compromission du CDN, détournement de paquet)
- casse le fonctionnement hors ligne
- l'étiquette `@latest` signifie que toute version future est chargée automatiquement, sans revue

**Recommandation :**
- Embarquer le paquet `@ionic/pwa-elements` localement (npm install + bundle)
- Ou figer une version précise avec une empreinte SRI (Subresource Integrity)
- Préférer l'embarquement local pour une application de niveau bancaire

### 8.6 Constat : la journalisation console peut divulguer des données sensibles
**Gravité : faible**

Sept appels à console.log/warn/error subsistent dans la couche service. En production, ils
peuvent divulguer des informations sensibles dans le logcat Android, accessible à d'autres
applications sur les appareils rootés (ou par ADB).

Points précis :
- `syncService.ts` journalise des détails de diagnostic d'authentification, dont des préfixes
  d'identifiant de session et des URL
- `databaseService.ts` journalise les étapes d'initialisation

**Recommandation :**
- Retirer `console.log/warn/error` des compilations de production (`drop_console` de Terser)
- Ou mettre en place un service de journalisation qui :
  - ne fait rien en production
  - ne journalise jamais d'identifiants, de jetons ni d'URL complètes
  - écrit éventuellement dans un fichier journal chiffré pour le débogage

### 8.7 Constat : aucun contrôle d'intégrité à l'exécution
**Gravité : moyenne**

L'application n'a aucun mécanisme anti-altération :
- aucune vérification de la signature de l'APK à l'exécution
- aucune détection de root ou de jailbreak
- aucune détection de débogueur
- aucune détection d'émulateur
- aucune détection de crochet (Frida, Xposed)

**Recommandation pour un niveau bancaire :**
- Mettre en place une détection de root via SafetyNet ou l'API Play Integrity
- Ajouter une détection de débogueur à l'exécution (`android.os.Debug.isDebuggerConnected()`)
- Détecter la présence des cadriciels Frida et Xposed
- Vérifier la signature de l'APK à l'exécution contre une empreinte en dur
- Avertir les utilisateurs sur les appareils rootés ; bloquer éventuellement les opérations sensibles
- Envisager des solutions commerciales : DexGuard, AppSolid ou Guardsquare

---

## 9. Conformité -- PIPEDA, RGPD, secteur bancaire

### 9.1 PIPEDA (Loi sur la protection des renseignements personnels et les documents électroniques)

La PIPEDA s'applique parce qu'ERPLibre est canadien (ca.erplibre.home) et traite des
renseignements personnels d'utilisateurs canadiens.

| Principe PIPEDA | État actuel | Manque |
|-----------------|-------------|--------|
| **Responsabilité** | Aucun responsable de la protection des données désigné | Désigner un responsable de la vie privée |
| **Détermination des fins** | Aucune politique de confidentialité dans l'app | Prévoir un avis de confidentialité intégré |
| **Consentement** | Aucun mécanisme de consentement à la collecte | Prévoir un parcours de consentement pour la géolocalisation, l'audio, la caméra |
| **Limitation de la collecte** | Collecte géolocalisation, audio, photos, vidéo | Revoir la nécessité de chaque type de donnée |
| **Limitation de l'utilisation** | Données employées pour les fonctions annoncées | Documenter les fins d'utilisation |
| **Exactitude** | La synchronisation garde les données à jour | Adéquat |
| **Mesures de sécurité** | Chiffrement au repos ; manques en transit | Traiter le trafic en clair et le stockage des identifiants |
| **Transparence** | Aucune politique de confidentialité | Publier une politique de confidentialité |
| **Accès aux renseignements** | Aucune fonction d'export | Mettre en œuvre la portabilité des données |
| **Possibilité de porter plainte** | Aucun mécanisme de plainte | Prévoir des coordonnées de contact |

**Actions requises :**
1. Créer une politique de confidentialité intégrée (bilingue EN/FR)
2. Mettre en place des dialogues de consentement avant le premier usage de la géolocalisation, de la caméra et du microphone
3. Ajouter une fonction d'export des données (droit d'accès)
4. Ajouter une fonction de suppression du compte et des données (droit à l'effacement)
5. Documenter les durées de conservation

### 9.2 RGPD (Règlement général sur la protection des données)

Le RGPD s'applique si l'application est utilisée par des résidents de l'UE ou traite des
données de personnes concernées dans l'UE (par exemple la synchronisation de notes portant
sur des clients européens depuis Odoo).

| Article du RGPD | Exigence | Manque |
|-----------------|----------|--------|
| Art. 5 | Minimisation des données | Vérifier si toutes les données collectées sont nécessaires |
| Art. 6 | Base légale | Aucune base légale documentée |
| Art. 7 | Conditions du consentement | Aucun mécanisme de consentement granulaire |
| Art. 12-14 | Transparence | Aucun avis de confidentialité |
| Art. 15 | Droit d'accès | Aucun export de données |
| Art. 17 | Droit à l'effacement | Partiel (suppression de notes possible, mais pas d'effacement complet) |
| Art. 20 | Portabilité des données | Aucun export dans un format lisible par machine |
| Art. 25 | Protection des données dès la conception | Chiffrement au repos en place, mais des manques subsistent |
| Art. 32 | Sécurité du traitement | Plusieurs manques recensés dans ce plan |
| Art. 33-34 | Notification de violation | Aucun plan de réponse aux incidents |
| Art. 35 | AIPD | Aucune analyse d'impact relative à la protection des données |

**Actions requises :**
1. Mener une analyse d'impact relative à la protection des données (AIPD)
2. Mettre en place une gestion granulaire du consentement
3. Ajouter un export des données au format JSON
4. Mettre en œuvre un effacement complet des données (y compris les fichiers en cache et les journaux)
5. Documenter la base légale du traitement de chaque catégorie de données

### 9.3 Réglementation bancaire canadienne

Pour les déploiements de niveau bancaire, les exigences supplémentaires suivantes
s'appliquent :

| Règlement | Exigence | État |
|-----------|----------|------|
| BSIF B-13 | Gestion du risque lié à la technologie et au cyberespace | Plusieurs manques |
| BSIF E-21 | Résilience opérationnelle | Aucun plan de continuité pour le mobile |
| PCI DSS (si données de carte) | Non applicable actuellement | À surveiller si des fonctions de paiement sont ajoutées |
| Loi sur le recyclage des produits de la criminalité | Piste d'audit pour les données financières | Historique de synchronisation partiel |

**Principales exigences bancaires non encore satisfaites :**
1. Authentification multifacteur (la biométrie seule peut ne pas suffire — il faut biométrie + NIP)
2. Signature des transactions pour les opérations critiques
3. Piste d'audit sécurisée avec détection d'altération
4. Prévention de la perte de données (DLP) pour les données financières
5. Cadence régulière de tests d'intrusion
6. Évaluation du risque fournisseur pour toutes les bibliothèques tierces

---

## 10. Évaluation OWASP Mobile Top 10

### M1 -- Usage incorrect des identifiants
**Risque : ÉLEVÉ**

| Constat | Gravité |
|---------|---------|
| Mots de passe Odoo stockés en clair en base | Élevée |
| Mots de passe et clés SSH stockés en clair en base | Élevée |
| Mot de passe du keystore de debug en dur (« android ») | Critique |
| Le script d'auto-connexion injecte les identifiants par interpolation de chaîne | Moyenne |
| `capacitor.config.json` contient le mot de passe du keystore | Critique |

### M2 -- Sécurité insuffisante de la chaîne d'approvisionnement
**Risque : MOYEN**

| Constat | Gravité |
|---------|---------|
| Script CDN externe (`unpkg.com`) avec l'étiquette `@latest` | Moyenne |
| Aucune analyse de vulnérabilité des dépendances (pas de npm audit en CI) | Moyenne |
| JSch 0.1.55 n'est plus maintenu (dernière publication en 2018) | Moyenne |
| Aucune génération de SBOM (nomenclature logicielle) | Faible |

### M3 -- Authentification et autorisation non sûres
**Risque : MOYEN**

| Constat | Gravité |
|---------|---------|
| Aucun repli par NIP en cas d'échec biométrique | Moyenne |
| Aucune expiration de session imposée | Moyenne |
| Aucune réauthentification pour les opérations sensibles (suppression de serveur, export de données) | Moyenne |
| Aucune option d'authentification multifacteur | Moyenne |

### M4 -- Validation insuffisante des entrées et sorties
**Risque : MOYEN**

| Constat | Gravité |
|---------|---------|
| Injection DOM non sûre dans webViewUtils.ts | Moyenne |
| Injection d'identifiants dans le script d'auto-connexion | Moyenne |
| Les requêtes SQL emploient des instructions paramétrées (bien) | -- |
| Échappement HTML dans buildHtml() (bien, mais incomplet — pas d'échappement de `'`) | Faible |

### M5 -- Communication non sûre
**Risque : CRITIQUE**

| Constat | Gravité |
|---------|---------|
| `usesCleartextTraffic="true"` globalement | Critique |
| `StrictHostKeyChecking="no"` en SSH | Critique |
| Aucun épinglage de certificat TLS | Élevée |
| SSE NTFY sans authentification | Élevée |
| RawHttpPlugin désactive globalement le CookieHandler | Moyenne |

### M6 -- Contrôles de confidentialité insuffisants
**Risque : ÉLEVÉ**

| Constat | Gravité |
|---------|---------|
| Aucune politique de confidentialité dans l'app | Élevée |
| Aucun mécanisme de consentement à la collecte | Élevée |
| Aucune fonction d'export des données | Moyenne |
| Aucune fonction de suppression complète des données | Moyenne |
| Géolocalisation stockée sans consentement explicite | Élevée |

### M7 -- Protections binaires insuffisantes
**Risque : ÉLEVÉ**

| Constat | Gravité |
|---------|---------|
| Minification Vite désactivée | Élevée |
| ProGuard/R8 désactivé | Élevée |
| Aucune détection de root | Moyenne |
| Aucune détection de débogueur | Moyenne |
| Aucune protection anti-altération | Moyenne |
| Aucune vérification de la signature du code à l'exécution | Faible |

### M8 -- Mauvaise configuration de sécurité
**Risque : ÉLEVÉ**

| Constat | Gravité |
|---------|---------|
| Keystore de debug versionné | Critique |
| `allowBackup="true"` dans le manifeste | Élevée |
| Aucune configuration de sécurité réseau | Élevée |
| Permissions excessives (stockage déprécié) | Moyenne |
| Aucune politique de sécurité du contenu | Élevée |

### M9 -- Stockage de données non sûr
**Risque : MOYEN**

| Constat | Gravité |
|---------|---------|
| Fichiers médias non chiffrés sur le système de fichiers | Moyenne |
| Identifiants en clair dans la base chiffrée | Élevée |
| Les journaux console peuvent fuir vers logcat | Faible |
| La gestion de la clé de chiffrement de la base est saine | -- |

### M10 -- Cryptographie insuffisante
**Risque : FAIBLE**

| Constat | Gravité |
|---------|---------|
| Chiffrement SQLCipher AES-256 (adéquat) | -- |
| Génération de clé par crypto.getRandomValues (adéquat) | -- |
| Aucun chiffrement secondaire pour les identifiants | Moyenne |
| L'échappement HTML omet l'entité apostrophe simple | Faible |

---

## 11. Réponse aux incidents

### 11.1 Scénarios d'incident propres au mobile

#### Scénario 1 : appareil volé ou perdu
**Risque actuel : MOYEN** (base chiffrée, mais aucun effacement à distance)

| Phase | Action |
|-------|--------|
| Préparation | Documenter le processus d'enrôlement des appareils |
| Détection | L'utilisateur signale la perte de l'appareil |
| Confinement | Révoquer la session Odoo côté serveur |
| Éradication | Changer tous les mots de passe stockés (Odoo + SSH) |
| Rétablissement | Configurer un nouvel appareil, restaurer depuis la synchro Odoo |
| Leçons | Envisager un enrôlement MDM |

**Contrôles recommandés :**
- Mettre en place un effacement d'urgence (déclenché par N saisies erronées du NIP)
- Prendre en charge l'effacement à distance par MDM (gestion de parc mobile)
- Verrouillage automatique après un délai d'inactivité configurable
- Vider le presse-papier après la copie de données sensibles

#### Scénario 2 : session Odoo compromise
**Risque actuel : ÉLEVÉ** (aucune rotation de jeton, aucune détection d'anomalie)

| Phase | Action |
|-------|--------|
| Détection | Surveiller l'usage concurrent d'une session sur le serveur |
| Confinement | Invalider l'identifiant de session sur le serveur Odoo |
| Éradication | Forcer une réauthentification dans l'application |
| Rétablissement | Vérifier l'absence de modifications de données non autorisées |
| Leçons | Mettre en place une détection d'anomalie de session |

**Contrôles recommandés :**
- Lier la session à l'identifiant de l'appareil (côté serveur Odoo)
- Détecter le détournement de session par changement d'adresse IP
- Mettre en place une rotation de jeton à chaque cycle de synchronisation

#### Scénario 3 : identifiants SSH compromis
**Risque actuel : CRITIQUE** (vérification de la clé d'hôte SSH désactivée)

| Phase | Action |
|-------|--------|
| Détection | Accès SSH anormal dans les journaux du serveur |
| Confinement | Désactiver la clé SSH, changer le mot de passe |
| Éradication | Auditer toutes les actions menées via la session compromise |
| Rétablissement | Régénérer les clés de tous les serveurs touchés |
| Leçons | Activer la vérification de la clé d'hôte SSH |

#### Scénario 4 : attaque sur la chaîne d'approvisionnement (dépendance compromise)
**Risque actuel : MOYEN** (aucune analyse des dépendances)

| Phase | Action |
|-------|--------|
| Détection | Avis de vulnérabilité ou comportement anormal |
| Confinement | Revenir à des versions de dépendances connues comme saines |
| Éradication | Auditer une éventuelle exfiltration de données |
| Rétablissement | Publier une version corrigée |
| Leçons | Mettre en place une analyse automatisée des dépendances |

### 11.2 Gabarit de plan de réponse aux incidents

1. **Préparation** : tenir à jour la liste de toutes les données stockées par l'app et de leur sensibilité
2. **Détection** : mettre en place la journalisation et la détection d'anomalie (voir la section 8.6)
3. **Confinement** : offrir une capacité de révocation de session à distance
4. **Éradication** : documenter les procédures de rotation des identifiants
5. **Rétablissement** : garantir que les données peuvent être restaurées depuis la synchro du serveur Odoo
6. **Après incident** : mettre à jour ce plan de sécurité avec les leçons apprises

---

## 12. Sécurité de la chaîne CI/CD

### 12.1 Constat : keystore de debug sous contrôle de version
**Gravité : CRITIQUE**

Le fichier `debug.keystore` (2730 octets) est versionné dans le dépôt Git.
`capacitor.config.json` contient le mot de passe du keystore en clair :

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

De plus, `generate-keystore.sh` génère un keystore avec le mot de passe « android » en dur.

**Ce qui signifie :**
- Quiconque a accès au dépôt peut signer des APK qui semblent provenir du développeur officiel
- Le keystore de debug est employé dans ce qui a l'air d'être la configuration de publication
- Si cet APK est distribué, toute mise à jour signée d'une autre clé sera rejetée par Android,
  tandis que n'importe quel attaquant peut créer une mise à jour malveillante signée de la même clé

**Recommandation :**
1. Retirer **immédiatement** `debug.keystore` du contrôle de version et l'ajouter au `.gitignore`
2. Générer un keystore de publication en règle, avec un mot de passe fort (32 caractères ou plus)
3. Stocker le keystore de publication et ses mots de passe dans un gestionnaire de secrets
   (GitHub Secrets, HashiCorp Vault ou un module matériel de sécurité, par exemple)
4. Employer des keystores distincts pour les compilations de débogage et de publication
5. Effectuer une rotation du keystore si l'actuel a été distribué
6. Sortir la configuration du keystore de `capacitor.config.json` vers des variables d'environnement
7. Envisager Google Play App Signing pour gérer la clé de téléversement séparément de la clé de signature

### 12.2 Constat : aucune analyse de vulnérabilité des dépendances
**Gravité : moyenne**

Rien n'indique une analyse automatisée des dépendances :
- pas de `npm audit` dans les scripts de compilation
- aucune configuration Dependabot ni Renovate
- aucune intégration de Snyk ou d'un outil équivalent
- aucune génération de SBOM

**Recommandation :**
- Ajouter `npm audit --audit-level=high` au pipeline d'intégration continue
- Configurer Dependabot ou Renovate pour la mise à jour automatisée des dépendances
- Générer un SBOM (au format CycloneDX) à chaque publication
- Mettre en place des alertes sur les vulnérabilités connues des dépendances
- Figer toutes les versions de dépendances (remplacer les `^` par des versions exactes dans `package.json`)

### 12.3 Constat : la bibliothèque JSch n'est plus maintenue
**Gravité : moyenne**

`com.jcraft:jsch:0.1.55` (employée dans `SshPlugin.java`) a été publiée pour la dernière fois
en 2018. Problèmes connus :
- aucune prise en charge des algorithmes modernes d'échange de clés SSH
- aucune prise en charge des clés Ed25519
- plusieurs vulnérabilités connues (CVE-2023-48795 : attaque Terrapin)

**Recommandation :**
- Migrer vers `com.github.mwiede:jsch:0.2.x` (fourche maintenue de JSch)
  ou `org.apache.sshd:sshd-core` (Apache MINA SSHD)
- S'assurer que la bibliothèque de remplacement prend en charge :
  - les clés Ed25519
  - le chiffrement ChaCha20-Poly1305
  - les algorithmes modernes d'échange de clés
  - une vérification correcte de la clé d'hôte

### 12.4 Recommandations de sécurité du pipeline de compilation

| Contrôle | Priorité | Description |
|----------|----------|-------------|
| Compilations reproductibles | Élevée | Figer toutes les versions d'outils (Node, npm, Gradle, SDK Android) |
| Isolation de la compilation | Élevée | Employer des environnements de compilation conteneurisés |
| Signature des artéfacts | Élevée | Signer les APK avec un keystore de publication en règle, en CI |
| Gestion des secrets | Critique | Sortir tous les secrets du contrôle de version |
| Vérification de la signature du code | Moyenne | Vérifier les commits signés en CI |
| SAST | Moyenne | Intégrer l'analyse statique (greffon de sécurité ESLint, MobSF) |
| DAST | Moyenne | Passer l'analyse dynamique MobSF sur les APK compilés |
| Analyse des licences | Faible | Vérifier que toutes les dépendances sont compatibles AGPL-3.0+ |

---

## 13. Recommandations priorisées

### Phase 1 -- Critique (immédiat, avant toute distribution)

| # | Constat | Action | Effort |
|---|---------|--------|--------|
| 1 | Trafic en clair activé | Poser `usesCleartextTraffic="false"`, ajouter la configuration de sécurité réseau | 2 heures |
| 2 | Keystore de debug versionné | Le retirer du dépôt, générer un keystore de publication, l'ajouter au `.gitignore` | 1 heure |
| 3 | Mot de passe du keystore dans capacitor.config.json | Le déplacer vers des variables d'environnement ou des secrets de CI | 1 heure |
| 4 | Vérification de la clé d'hôte SSH désactivée | Mettre en place une vérification TOFU de la clé d'hôte | 2 jours |
| 5 | `allowBackup="true"` | Poser `false` ou mettre en place un `EncryptedBackupAgent` | 30 minutes |

### Phase 2 -- Élevée (sous deux semaines)

| # | Constat | Action | Effort |
|---|---------|--------|--------|
| 6 | Identifiants en clair en base | Chiffrer les colonnes d'identifiants avec une clé secondaire | 3 jours |
| 7 | Aucun épinglage de certificat TLS | Mettre en place la configuration de sécurité réseau + épinglage TOFU | 2 jours |
| 8 | Minification Vite désactivée | Activer Terser en production, retirer les console.log | 1 heure |
| 9 | ProGuard/R8 désactivé | Activer R8 avec les règles keep adéquates | 2 jours |
| 10 | Aucune CSP | Ajouter une balise meta de politique de sécurité du contenu | 1 heure |
| 11 | NTFY non authentifié | Ajouter une authentification par jeton Bearer | 1 jour |
| 12 | Script CDN externe | Embarquer `@ionic/pwa-elements` localement | 1 heure |
| 13 | Aucune analyse des dépendances | Ajouter npm audit à la CI, configurer Dependabot | 2 heures |
| 14 | JSch non maintenu | Migrer vers la fourche maintenue (mwiede/jsch) | 1 jour |

### Phase 3 -- Moyenne (sous un mois)

| # | Constat | Action | Effort |
|---|---------|--------|--------|
| 15 | Aucun repli par NIP | Mettre en place une saisie de NIP sécurisée avec verrouillage | 3 jours |
| 16 | Aucune expiration de session | Ajouter une expiration de session configurable | 1 jour |
| 17 | Fichiers médias non chiffrés | Mettre en place un chiffrement au niveau du fichier | 3 jours |
| 18 | Aucune politique de confidentialité | Rédiger une politique de confidentialité bilingue | 2 jours |
| 19 | Aucun mécanisme de consentement | Ajouter des dialogues de consentement pour la géolocalisation, la caméra et le micro | 2 jours |
| 20 | Injection d'identifiants dans le script de connexion | Assainir les identifiants avant l'injection dans le script | 4 heures |
| 21 | Injection DOM non sûre dans webViewUtils | Retirer le chemin de code mort | 30 minutes |
| 22 | Permissions de stockage dépréciées | Les retirer, employer le stockage cloisonné | 1 jour |
| 23 | Détection de root et de débogueur | Mettre en place des contrôles d'intégrité de base | 2 jours |
| 24 | Export et effacement des données | Les mettre en œuvre pour la conformité PIPEDA/RGPD | 3 jours |
| 25 | Sûreté multithread de RawHttpPlugin | Migrer vers OkHttp ou ajouter une synchronisation | 2 jours |

### Phase 4 -- Faible et améliorations (sous trois mois)

| # | Constat | Action | Effort |
|---|---------|--------|--------|
| 26 | Aucune génération de SBOM | Intégrer CycloneDX à la CI | 2 heures |
| 27 | Aucun test d'intrusion | Commander un test d'intrusion externe | Externe |
| 28 | Aucune AIPD | Mener une analyse d'impact relative à la protection des données | 3 jours |
| 29 | Aucune prise en charge MDM | Évaluer une intégration MDM pour l'entreprise | 2 semaines |
| 30 | Détection d'anomalie de session | Lier les sessions à l'identifiant de l'appareil | 2 jours |
| 31 | Piste d'audit sécurisée | Mettre en place une journalisation infalsifiable | 3 jours |
| 32 | Anti-altération avancé | Évaluer DexGuard ou équivalent | Externe |

---

## 14. Registre des risques

| ID | Risque | Vraisemblance | Impact | Score | Atténuation | État |
|----|--------|--------------|--------|-------|-------------|------|
| R-01 | Attaque MITM sur le trafic HTTP en clair | Élevée | Critique | **Critique** | Désactiver le trafic en clair, imposer HTTPS | Ouvert |
| R-02 | Compromission de la clé de signature de l'APK via le keystore versionné | Élevée | Critique | **Critique** | Le retirer du contrôle de version, gérer les clés correctement | Ouvert |
| R-03 | MITM SSH par vérification de clé d'hôte désactivée | Moyenne | Critique | **Critique** | Mettre en place une vérification TOFU de la clé d'hôte | Ouvert |
| R-04 | Vol d'identifiants depuis la base chiffrée par exploit root | Moyenne | Élevé | **Élevé** | Chiffrement secondaire avec liaison biométrique | Ouvert |
| R-05 | Détournement de session faute d'épinglage de certificat | Moyenne | Élevé | **Élevé** | Mettre en place l'épinglage de certificat | Ouvert |
| R-06 | Attaque sur la chaîne d'approvisionnement via le script CDN | Faible | Critique | **Élevé** | Embarquer les dépendances localement | Ouvert |
| R-07 | Usurpation de notification NTFY | Moyenne | Moyen | **Moyen** | Mettre en place l'authentification NTFY | Ouvert |
| R-08 | Rétro-ingénierie sur du code non obfusqué | Élevée | Moyen | **Moyen** | Activer la minification et R8 | Ouvert |
| R-09 | Extraction de données d'un appareil volé | Moyenne | Élevé | **Élevé** | Verrouillage automatique, effacement à distance, repli par NIP | Ouvert |
| R-10 | Atteinte à la vie privée (PIPEDA/RGPD) | Moyenne | Élevé | **Élevé** | Politique de confidentialité, consentement, portabilité | Ouvert |
| R-11 | Vulnérabilité connue dans JSch 0.1.55 | Moyenne | Élevé | **Élevé** | Migrer vers une bibliothèque SSH maintenue | Ouvert |
| R-12 | XSS via l'injection DOM non sûre de webViewUtils | Faible | Moyen | **Moyen** | Retirer le chemin de code mort | Ouvert |
| R-13 | Extraction de données par la sauvegarde Android | Moyenne | Moyen | **Moyen** | Désactiver les sauvegardes ou les chiffrer | Ouvert |
| R-14 | Divulgation d'information via console.log | Faible | Faible | **Faible** | Retirer console en production | Ouvert |
| R-15 | Déni de service par déclenchements NTFY sans limite de débit | Faible | Moyen | **Faible** | Limiter la cadence des déclenchements de synchronisation | Ouvert |

---

## 15. Feuille de route de mise en œuvre

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

## Annexe A : modèle de menaces (STRIDE)

| Menace | Catégorie | Actif | Atténuation |
|--------|-----------|-------|-------------|
| Un attaquant intercepte le trafic HTTP | Usurpation, altération, divulgation | Identifiants, identifiants de session, données de notes | Désactiver le clair, imposer HTTPS, épingler les certificats |
| Un attaquant se fait passer pour le serveur SSH | Usurpation | Identifiants SSH | Vérification TOFU de la clé d'hôte |
| Un attaquant extrait les données d'un appareil volé | Divulgation d'information | Toutes les données locales | NIP/biométrie, chiffrement, effacement à distance |
| Un attaquant décompile l'APK | Divulgation d'information | Logique métier, points d'accès d'API | Minification, R8, anti-altération |
| Un attaquant exploite une CVE connue de JSch | Élévation de privilège | Sessions SSH | Passer à une bibliothèque maintenue |
| Un attaquant signe un APK malveillant avec le keystore versionné | Usurpation | Identité de l'application | Retirer le keystore du contrôle de version |
| Un attaquant exploite l'injection DOM non sûre | Altération, élévation de privilège | Contexte de la WebView | Retirer le code mort, ajouter une CSP |
| Un attaquant lit le sujet NTFY | Divulgation d'information | Contenu des notifications | Authentification NTFY |
| Un attaquant déclenche une synchronisation via NTFY | Déni de service | Disponibilité du service de synchro | Limitation de débit, validation des messages |
| Un appareil rooté extrait la clé de chiffrement | Divulgation d'information | Toutes les données chiffrées | Clé du Keystore liée à la biométrie |

## Annexe B : inventaire des dépendances (pertinentes pour la sécurité)

| Paquet | Version | Notes de risque |
|--------|---------|-----------------|
| `@capacitor/core` | ^8.0.0 | Cadriciel de base — à garder à jour |
| `@aparajita/capacitor-biometric-auth` | ^10.0.0 | Enveloppe de l'API biométrique |
| `capacitor-secure-storage-plugin` | ^0.13.0 | Critique — stocke les clés de chiffrement |
| `@capacitor-community/sqlite` | ^8.0.0 | Enveloppe SQLCipher — critique |
| `@capgo/inappbrowser` | ^8.5.0 | WebView — vecteur XSS possible |
| `com.jcraft:jsch:0.1.55` | 0.1.55 | **NON MAINTENU** — CVE-2023-48795 |
| `com.google.mlkit:text-recognition` | 16.0.1 | OCR ML Kit — dépendance Google |
| `@ionic/pwa-elements` | @latest (CDN) | **NON FIGÉ** — risque sur la chaîne d'approvisionnement |
| `sortablejs` | ^1.15.6 | Bibliothèque de manipulation du DOM |
| `uuid` | ^13.0.0 | Génération d'identifiants — emploie crypto.getRandomValues |

## Annexe C : liste de contrôle de conformité

### Vérification rapide PIPEDA

- [ ] Politique de confidentialité accessible dans l'app (EN + FR)
- [ ] Consentement obtenu avant de collecter la géolocalisation
- [ ] Consentement obtenu avant d'accéder à la caméra
- [ ] Consentement obtenu avant d'accéder au microphone
- [ ] Durées de conservation documentées
- [ ] Fonction d'export des données mise en œuvre
- [ ] Fonction de suppression des données mise en œuvre
- [ ] Mesures de sécurité documentées
- [ ] Procédure de notification de violation documentée
- [ ] Responsable de la protection des données désigné

### Vérification rapide RGPD

- [ ] Base légale documentée pour chaque activité de traitement
- [ ] Analyse d'impact relative à la protection des données réalisée
- [ ] Avis de confidentialité conforme aux art. 13 et 14
- [ ] Droit d'accès mis en œuvre (art. 15)
- [ ] Droit à l'effacement mis en œuvre (art. 17)
- [ ] Droit à la portabilité mis en œuvre (art. 20)
- [ ] Registre des traitements tenu à jour (art. 30)
- [ ] Accords de sous-traitance en place (hébergement Odoo, NTFY)
- [ ] Garanties de transfert transfrontalier (si des données de l'UE quittent le Canada)

---

*Ce plan de sécurité doit être relu et mis à jour chaque trimestre, ou immédiatement à la
suite de tout changement d'architecture significatif, de tout ajout de fonctionnalité ou de
tout incident de sécurité.*

*Prochaine date de revue : 2026-07-14*
