/**
 * Generates a JPEG thumbnail from the first frame of a video.
 * @param videoWebUrl - A URL accessible by the WebView (e.g. https://localhost/_capacitor_file_/...)
 * @returns Base64-encoded JPEG data (without the data: prefix)
 */
export function generateVideoThumbnail(videoWebUrl: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;

		video.addEventListener("loadedmetadata", () => {
			video.currentTime = 0.1;
		});

		video.addEventListener("seeked", () => {
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth || 1280;
			canvas.height = video.videoHeight || 720;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("Canvas 2D context unavailable"));
				return;
			}
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
			resolve(dataUrl.split(",")[1]);
		});

		video.addEventListener("error", () => {
			reject(new Error(`Video load error for: ${videoWebUrl}`));
		});

		video.src = videoWebUrl;
	});
}
