package ca.erplibre.home;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ChatImageSizeTest {

    @Test
    public void landscapeFitsItsWidth() {
        assertArrayEquals(new int[] {1920, 1440}, ChatImageSize.fit(4032, 3024, 1920));
    }

    @Test
    public void portraitFitsItsHeight() {
        assertArrayEquals(new int[] {1440, 1920}, ChatImageSize.fit(3024, 4032, 1920));
    }

    @Test
    public void alreadySmallKeepsItsSize() {
        assertArrayEquals(new int[] {800, 600}, ChatImageSize.fit(800, 600, 1920));
        assertArrayEquals(new int[] {1920, 1080}, ChatImageSize.fit(1920, 1080, 1920));
    }

    @Test
    public void zeroKeepsTheSize() {
        assertArrayEquals(new int[] {4032, 3024}, ChatImageSize.fit(4032, 3024, 0));
    }

    @Test
    public void roundsAndNeverGoesUnderOnePixel() {
        assertArrayEquals(new int[] {1920, 1281}, ChatImageSize.fit(3000, 2001, 1920));
        assertArrayEquals(new int[] {1920, 1}, ChatImageSize.fit(20000, 3, 1920));
    }

    @Test
    public void sampleSizeDecodesNoSmallerThanTheFit() {
        assertEquals(2, ChatImageSize.sampleSize(4032, 3024, 1920));
        assertEquals(4, ChatImageSize.sampleSize(8000, 6000, 1920));
        assertEquals(2, ChatImageSize.sampleSize(3840, 3840, 1920));
        assertEquals(1, ChatImageSize.sampleSize(800, 600, 1920));
        assertEquals(1, ChatImageSize.sampleSize(8000, 6000, 0));
    }
}
