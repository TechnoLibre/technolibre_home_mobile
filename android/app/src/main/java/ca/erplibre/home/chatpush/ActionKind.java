package ca.erplibre.home.chatpush;

/** An action button a chat notification offers. */
enum ActionKind {
    /** « Répondre »: a text typed in the notification, posted to the conversation. */
    REPLY,
    /** « Marquer lu »: the conversation marked read up to its newest message. */
    READ,
    /** « Muet 1 h »: the conversation muted for an hour. */
    MUTE,
    /** « 👍 »: a reaction on the newest message, offered only when its id is known. */
    REACT
}
