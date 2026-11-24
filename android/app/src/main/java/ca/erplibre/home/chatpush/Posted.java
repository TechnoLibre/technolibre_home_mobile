package ca.erplibre.home.chatpush;

/** A message Odoo accepted: its id and the Store answer (null when it is too big to keep). */
final class Posted {

    final long messageId;
    final String answer;

    Posted(long messageId, String answer) {
        this.messageId = messageId;
        this.answer = answer;
    }

    @Override
    public String toString() {
        return "Posted{" + messageId + "}";
    }
}
