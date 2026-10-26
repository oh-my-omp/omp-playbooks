import { readImageFromClipboard } from "@oh-my-pi/pi-natives/clipboard";
import type { ClipboardImageReader } from "./ui";

/** The PNG data on the macOS pasteboard, as AppleScript reads it: `«data PNGf<hex>»`; null when there is none. */
async function pasteboardPng(): Promise<Uint8Array | null> {
	const child = Bun.spawn(["osascript", "-e", "the clipboard as «class PNGf»"], { stdout: "pipe", stderr: "ignore" });
	const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	const hex = code === 0 ? /«data PNGf([0-9A-Fa-f]+)»/.exec(text)?.[1] : undefined;
	return hex ? new Uint8Array(Buffer.from(hex, "hex")) : null;
}

/**
 * The clipboard image, read as omp reads it. On macOS a copied file (Finder, QQ, …) makes that
 * reader open the file, which another app's container forbids; the pasteboard's own PNG data
 * needs no file, so it is read when the first reader finds nothing.
 */
export const readClipboardImage: ClipboardImageReader = async () => {
	let failure: unknown = null;
	try {
		const image = await readImageFromClipboard();
		if (image) return image;
	} catch (error) {
		failure = error;
	}
	if (process.platform === "darwin") {
		const png = await pasteboardPng();
		if (png) return { data: png, mimeType: "image/png" };
	}
	if (failure !== null) throw failure;
	return null;
};
