package ca.erplibre.home.streamdeck.events;

import com.getcapacitor.JSObject;

/**
 * Functional interface implemented by StreamDeckPlugin to expose the protected
 * notifyListeners(String, JSObject) bridge to the streamdeck.* package.
 */
public interface EventEmitter {
    void emit(String eventName, JSObject data);
}
