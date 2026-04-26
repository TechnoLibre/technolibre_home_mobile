package ca.erplibre.home.streamdeck.transport;

import java.util.List;

/**
 * Pagination strategy per Stream Deck generation. Only pure logic lives here;
 * USB I/O is performed by DeckSession.
 */
public interface DeckTransport {

    /** Split an encoded key image into HID OUT pages (full page size, header + payload + zero-pad). */
    List<byte[]> paginateKeyImage(int keyIndex, byte[] imageBytes);

    /**
     * Total page size including header. Used by DeckSession to size the bulk transfer buffer
     * and validate writes.
     */
    int pageSize();
}
