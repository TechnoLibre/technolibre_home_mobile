export type IntentType = "text" | "image" | "video";

export abstract class ImplicitIntent {
  private _mimeType: string;
  private _type: IntentType;

  constructor(newMimeType: string, newType: IntentType) {
    this._mimeType = newMimeType;
    this._type = newType;
  }

  public get mimeType(): string {
    return this._mimeType;
  }

  public get type(): IntentType {
    return this._type;
  }
};

export class TextIntent extends ImplicitIntent {
  private _text: string;

  constructor(newMimeType: string, newText: string) {
    super(newMimeType, "text");
    this._text = newText;
  }

  public get text(): string {
    return this._text;
  }
}

export class ImageIntent extends ImplicitIntent {
  private _url: string;

  constructor(newMimeType: string, newUrl: string) {
    super(newMimeType, "image");
    this._url = newUrl;
  }

  public get url(): string {
    return this._url;
  }
}

export class VideoIntent extends ImplicitIntent {
  private _url: string;

  constructor(newMimeType: string, newUrl: string) {
    super(newMimeType, "video");
    this._url = newUrl;
  }

  public get url(): string {
    return this._url;
  }
}