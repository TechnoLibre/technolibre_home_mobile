import { EventBus } from "@odoo/owl";
import { Intent, SendIntent } from "@supernotes/capacitor-send-intent";
import { Events } from "../constants/events";
import { ImageIntent, ImplicitIntent, IntentType, TextIntent, VideoIntent } from "../models/intent";

export class IntentService {
  private _eventBus: EventBus;
  private _intent?: ImplicitIntent;

  constructor(newEventBus: EventBus) {
    this._eventBus = newEventBus;
    this.listenForIntents();
  }

  public get eventBus(): EventBus {
    return this._eventBus;
  }

  public get intent(): ImplicitIntent | undefined {
    return this._intent;
  }

  public set intent(newIntent: ImplicitIntent) {
    this._intent = newIntent;
  }

  public clearIntent() {
    this._intent = undefined;
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

  public isIntentType(broadType?: string): broadType is IntentType {
    if (!broadType) {
      return false;
    }

    return ["text", "image", "video"].includes(broadType);
  }

  /** Route a pending share to /intent/<type>. The plugin rejects every
   *  launch that is not a share ("No processing needed"), so a rejection
   *  means no pending intent; the constructor does not await this call,
   *  so nothing else would catch it. */
  private async listenForIntents(): Promise<void> {
    let value: Intent;
    try {
      value = await SendIntent.checkSendIntentReceived();
    } catch {
      return;
    }

    if (!value || !value.type) {
      return;
    }

    const intent = this.from(value);

    if (!intent) {
      return;
    }

    this._intent = intent;
    this.eventBus.trigger(Events.ROUTER_NAVIGATION, { url: `/intent/${intent.type}` });
  }
}