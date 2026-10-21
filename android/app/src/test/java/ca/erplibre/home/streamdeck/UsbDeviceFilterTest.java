package ca.erplibre.home.streamdeck;

import static org.junit.Assert.*;
import org.junit.Test;

import java.io.File;
import java.util.HashSet;
import java.util.Set;

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * A hotplug attach shows no dialog of its own: it waits for the
 * confirmation Android raises for a device the manifest's
 * USB_DEVICE_ATTACHED filter matches. That holds only while the filter
 * lists every product DeckRegistry opens, under the Elgato vendor id.
 */
public class UsbDeviceFilterTest {

    /** Unit tests run from the module directory. */
    private static final File FILTER = new File("src/main/res/xml/streamdeck_devices.xml");

    private static Set<Integer> filteredProducts() throws Exception {
        Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(FILTER);
        NodeList nodes = doc.getElementsByTagName("usb-device");
        Set<Integer> out = new HashSet<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            Element e = (Element) nodes.item(i);
            assertEquals("vendor-id of every entry",
                DeckRegistry.ELGATO_VENDOR_ID, Integer.parseInt(e.getAttribute("vendor-id")));
            out.add(Integer.parseInt(e.getAttribute("product-id")));
        }
        return out;
    }

    @Test
    public void the_filter_lists_exactly_the_known_decks() throws Exception {
        assertTrue(FILTER.getAbsolutePath(), FILTER.isFile());
        assertEquals(DeckRegistry.productIds(), filteredProducts());
    }
}
