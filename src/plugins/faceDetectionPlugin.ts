import { registerPlugin } from "@capacitor/core";

export interface FaceBox {
    /** Normalised bounding box in [0, 1] relative to the input frame size. */
    x: number;
    y: number;
    width: number;
    height: number;
}

interface FaceDetectionPluginApi {
    /** One-shot detect on a JPEG frame. Throws if the WebView passed an
     *  empty or undecodable payload; resolves with [] when no face is
     *  found. Caller owns the cadence — there's no streaming API. */
    detectFaces(opts: { jpegBase64: string }): Promise<{ faces: FaceBox[] }>;
}

export const FaceDetectionPlugin =
    registerPlugin<FaceDetectionPluginApi>("FaceDetectionPlugin");
