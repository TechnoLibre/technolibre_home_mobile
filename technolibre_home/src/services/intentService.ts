import { EventBus } from "@odoo/owl";
import { Intent, SendIntent } from "@supernotes/capacitor-send-intent";
import { Events } from "../constants/events";
import { ImageIntent, IntentType, TextIntent, VideoIntent } from "../models/intent";

export class IntentService {
  private _eventBus: EventBus;

  constructor(newEventBus: EventBus) {
    this._eventBus = newEventBus;
    this.listenForIntents();
  }

  public get eventBus(): EventBus {
    return this._eventBus;
  }

  public getBroadType(exactType?: string): string | undefined {
    if (!exactType) {
      return undefined;
    }

    const regex = new RegExp('.*?(?=(\/))');
    const matches = regex.exec(exactType);

    if (!matches) {
      return undefined;
    }

    return matches[0];
  }

  public from(intent: Intent) {
    if (!intent.type || !intent.url) {
      return;
    }

    const broadType = this.getBroadType(intent.type);

    if (!this.isIntentType(broadType)) {
      return;
    }

    const intentType = broadType as IntentType;

    switch (intentType) {
      case "text":
        return new TextIntent(intent.type, intent.url);
      case "image":
        return new ImageIntent(intent.type, intent.url)
      case "video":
        return new VideoIntent(intent.type, intent.url);
      default:
        break;
    }
  }

  private async listenForIntents(): Promise<void> {
    const value: Intent = await SendIntent.checkSendIntentReceived();

    if (!value || !value.type) {
      return;
    }

    this.eventBus.trigger(Events.RECEIVE_INTENT, { intent: value });
  }

  private isIntentType(broadType?: string): broadType is IntentType {
    if (!broadType) {
      return false;
    }

    return ["text", "image", "video"].includes(broadType);
  }
}