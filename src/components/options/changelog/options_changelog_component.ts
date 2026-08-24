import { xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { versionToDisplay } from "../../../services/migrationService";

const CURRENT_VERSION = 2026082401;

// Résumé par version, dans le style de CHANGELOG.md mais volontairement plus
// court : c'est une alerte native, pas le journal complet. Le contenu duplique
// CHANGELOG.md et doit donc être mis à jour à chaque release — un chargement de
// `/repo/CHANGELOG.md` depuis le bundle supprimerait cette duplication.
const RELEASES: string[] = [
    `=== 2026.08.24.01 ===
Added:
- Elgato Stream Deck: native Android USB stack,
  seven models, camera streaming, face detection
- Code editing: git-backed edits on bundled repos
- Photo gallery across every note
- Bilingual feature catalogue with dependency graph
- tar.gz bundle pipeline with lazy extraction
- Groq transcription backend (opt-in)
Changed:
- Full Owl AOT template coverage
- Test suite 854 -> 979 tests
Fixed:
- Stream Deck reliability: reads, resets, sleep
- Transcription persisted whatever the UI does
Security:
- Audit findings closed at every severity
- Credential encryption and certificate pinning`,
    `=== 2026.04.14.01 ===
Added:
- Code browser (/options/code) with Bundle,
  SSH Path and SSH URL modes
- Zero-dependency syntax highlighting
- Markdown preview and image viewer
- Vite source bundler
Changed:
- Bundle excludes build artifacts and files > 1 MB`,
    `=== 2026.04.13.01 ===
Added:
- Whisper on-device transcription (6 models)
- ML Kit OCR on photo entries
- SSH network scan and ERPLibre deployment
- Process journal, resource monitor
- Hierarchical tags, Eisenhower priority
Changed:
- WakeLock and Foreground Service downloads
- Light/dark themes with 4 presets
Fixed:
- OOM on models > 200 MB (removed fetch fallback)`,
    `=== 2026.03.18.01 ===
Added:
- SQLite backend with AES-256 encryption
- Biometric protection for DB key (opt-in)
- Versioned migration system + notification
- Boot screen with init progress
- Options sub-pages with breadcrumbs
- SQLite DB size diagnostic
- Video: HTML5 overlay playback
- Video: thumbnail (first frame, cached)
- Video: thumbnail backfill migration
- Video: auto-open camera on new entry
- Photo: capture + fullscreen viewer
- Photo: auto-open camera on new entry
- Geolocation: open native map button
Fixed:
- Stale listeners causing ghost entries
- Video camera opening on all note views
- Race condition on photo camera open`,
    `=== 2025.12.28.01 ===
Added:
- Application management (add/edit/delete)
- Notes with text, audio, video, photo,
  and geolocation entries
- Tags and labels for notes
- Data stored in SecureStorage`,
];

export class OptionsChangelogComponent extends EnhancedComponent {
  static template = xml`
    <li id="changelog" class="options-list__item">
      <a href="#" t-on-click.stop.prevent="onChangelogClick">
        📋 Version <t t-esc="currentVersion"/>
      </a>
    </li>
  `;

  get currentVersion() {
    return versionToDisplay(CURRENT_VERSION);
  }

  async onChangelogClick() {
    await Dialog.alert({
      title: `Changelog — ${versionToDisplay(CURRENT_VERSION)}`,
      message: RELEASES.join("\n\n"),
    });
  }
}
