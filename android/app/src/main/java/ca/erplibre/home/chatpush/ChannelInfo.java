package ca.erplibre.home.chatpush;

/** A mirrored conversation: its name and type (chat, group or channel). */
final class ChannelInfo {

    final String name;
    final String type;

    ChannelInfo(String name, String type) {
        this.name = name == null ? "" : name;
        this.type = type == null ? "" : type;
    }
}
