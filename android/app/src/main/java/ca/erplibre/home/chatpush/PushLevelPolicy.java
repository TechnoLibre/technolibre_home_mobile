package ca.erplibre.home.chatpush;

/**
 * Turns the level the user chose (1 to 5) into what the app does: how it
 * listens (realtime stream, 15 or 60 minute poll, nothing), whether a
 * permanent foreground service is needed, and whether Odoo itself is still
 * asked for the unread state. A LevelClimber may raise the level from the
 * power state; the default leaves it alone.
 */
final class PushLevelPolicy {

    private PushLevelPolicy() {}

    enum Mode { REALTIME, POLL_15, POLL_60, OFF }

    /** Network and battery facts a climber decides on. */
    static final class PowerState {
        final boolean wifi;
        final boolean charging;
        final boolean saver;
        final int batteryPct;

        PowerState(boolean wifi, boolean charging, boolean saver, int batteryPct) {
            this.wifi = wifi;
            this.charging = charging;
            this.saver = saver;
            this.batteryPct = batteryPct;
        }
    }

    /** Returns the level to apply for the chosen one; the result is clamped to 1..5 by resolve. */
    interface LevelClimber {
        int climb(int chosen, PowerState s);
    }

    static final LevelClimber NO_CLIMB = (chosen, s) -> chosen;

    static final class Effective {
        final int level;
        final Mode mode;
        final boolean permanentService;
        final boolean odooDirect;

        Effective(int level, Mode mode, boolean permanentService, boolean odooDirect) {
            this.level = level;
            this.mode = mode;
            this.permanentService = permanentService;
            this.odooDirect = odooDirect;
        }
    }

    /**
     * Level 1 keeps the stream open; 2 does too on wifi or charger, else polls
     * every 15 minutes, with the service either way; 3 polls every 15 minutes,
     * 4 every 60; 5 is off and leaves Odoo's unread state alone. A build without
     * the realtime service maps 1 and 2 to 3.
     */
    static Effective resolve(int chosen, PowerState s, boolean realtimeBuild, LevelClimber climber) {
        int level = clamp(climber.climb(chosen, s));
        if (!realtimeBuild && level < 3) level = 3;
        Mode mode;
        boolean permanent = false;
        switch (level) {
            case 1:
                mode = Mode.REALTIME;
                permanent = true;
                break;
            case 2:
                mode = s.wifi || s.charging ? Mode.REALTIME : Mode.POLL_15;
                permanent = true;
                break;
            case 3:
                mode = Mode.POLL_15;
                break;
            case 4:
                mode = Mode.POLL_60;
                break;
            default:
                mode = Mode.OFF;
                break;
        }
        return new Effective(level, mode, permanent, level <= 4);
    }

    /**
     * What a level wanting the permanent service does while none runs: it
     * polls every 15 minutes, keeping its level and its want of the service.
     */
    static Effective withoutService(Effective e) {
        return new Effective(e.level, Mode.POLL_15, e.permanentService, e.odooDirect);
    }

    private static int clamp(int level) {
        return Math.max(1, Math.min(5, level));
    }
}
