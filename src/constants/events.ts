export const Events: Record<string, string> = {
	ROUTER_NAVIGATION: "routernav",
	TAG_MANAGER: "tag_manager",
	DATE_PICKER: "date_picker",
	GEOLOCATION: "geolocation",
	FOCUS_LAST_ENTRY: "focus_last_entry",
	OPEN_CAMERA: "open_camera",
	CLOSE_CAMERA: "close_camera",
	SET_AUDIO_RECORDING: "set_audio_recording",
	SET_VIDEO_RECORDING: "set_video_recording",
	SET_PHOTO: "set_photo",
	RELOAD_NOTES: "reload_notes",
	SET_INTENT: "set_intent",
	SCROLL_TO_LAST_ENTRY: "scroll_to_last_entry",
	SYNC_CHANGES_DETECTED: "sync_changes_detected",
	DEV_MODE_UNLOCKED: "dev_mode_unlocked",
	ADD_TRANSCRIPTION_TEXT: "add_transcription_text",
	SET_ENTRY_TRANSCRIPTION: "set_entry_transcription",
	NOTE_TAGS_UPDATED: "note_tags_updated",
	TAGS_UPDATED: "tags_updated",
	STREAMDECK_NOTE_PAGE_ACTIVE: "streamdeck_note_page_active",
	STREAMDECK_ADD_AUDIO: "streamdeck_add_audio",
	STREAMDECK_ADD_VIDEO: "streamdeck_add_video",
	STREAMDECK_ADD_LOCATION: "streamdeck_add_location",
	/** Fired by OptionsGalleryComponent on mount/unmount with the
	 *  current image list so the controller can paint deck thumbs. */
	STREAMDECK_GALLERY_PAGE_ACTIVE: "streamdeck_gallery_page_active",
	/** Controller → component: open the image at the given index in
	 *  fullscreen on the mobile. */
	STREAMDECK_GALLERY_OPEN: "streamdeck_gallery_open",
	/** Controller → component: close fullscreen / navigate back. */
	STREAMDECK_GALLERY_BACK: "streamdeck_gallery_back",
}
