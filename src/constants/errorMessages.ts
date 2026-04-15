import { t } from "../i18n";

// @ts-ignore
const LABEL_NOTE: string = import.meta.env.VITE_LABEL_NOTE ?? "note";

/**
 * Error messages resolved at access time so they reflect the current locale.
 * API is unchanged: ErrorMessages.APP_KEY_NOT_FOUND etc.
 */
export const ErrorMessages = {
  get APP_KEY_NOT_FOUND()  { return t("error.app_key_not_found"); },
  get NOTE_KEY_NOT_FOUND() { return t("error.note_key_not_found", { label: LABEL_NOTE }); },
  get UNDEFINED_APP_LIST() { return t("error.undefined_app_list"); },
  get UNDEFINED_NOTE_LIST(){ return t("error.undefined_note_list", { label: LABEL_NOTE }); },
  get NO_APP_MATCH()       { return t("error.no_app_match"); },
  get NO_NOTE_MATCH()      { return t("error.no_note_match",  { label: LABEL_NOTE }); },
  get NO_NOTE_ENTRY_MATCH(){ return t("error.no_note_entry_match", { label: LABEL_NOTE }); },
  get APP_ALREADY_EXISTS() { return t("error.app_already_exists"); },
  get BIOMETRIC_AUTH()     { return t("error.biometric_auth"); },
  get APP_DELETE()         { return t("error.app_delete"); },
  get NOTE_DELETE()        { return t("error.note_delete", { label: LABEL_NOTE }); },
  get APP_SAVE()           { return t("error.app_save"); },
  get EMPTY_FIELDS()       { return t("error.empty_fields"); },
  get VOICE_RECORDING_INCOMPATIBLE() { return t("error.voice_recording_incompatible"); },
  get VOICE_RECORDING_PERMISSIONS()  { return t("error.voice_recording_permissions"); },
  get VOICE_RECORDING_GENERIC()      { return t("error.voice_recording_generic"); },
  get VIDEO_RECORDING_WEB()          { return t("error.video_recording_web"); },
  get SERVER_ALREADY_EXISTS()        { return t("error.server_already_exists"); },
  get NO_SERVER_MATCH()              { return t("error.no_server_match"); },
  get SERVER_DELETE()                { return t("error.server_delete"); },
  get SERVER_SAVE()                  { return t("error.server_save"); },
  get SSH_CONNECT_FAILED()           { return t("error.ssh_connect_failed"); },
  get SSH_COMMAND_FAILED()           { return t("error.ssh_command_failed"); },
};
