// Timeline paging (K1 `timeline`): `entries` is strictly increasing by `seq`, so the page after
// `after` starts at a binary-searched index and a page is one slice — no full-array filter.
import type { TimelineEntry } from "../domain/model";

export interface TimelinePage {
	readonly entries: readonly TimelineEntry[];
	/** Present only when the page was truncated: pass it as the next `after`. */
	readonly next_after?: number;
}

/** Entries with `seq > after`, at most `limit`; without `limit`, all of them and no `next_after`. */
export function pageTimeline(entries: readonly TimelineEntry[], after: number, limit?: number): TimelinePage {
	let lo = 0;
	let hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (entries[mid]!.seq <= after) lo = mid + 1;
		else hi = mid;
	}
	const end = limit === undefined ? entries.length : Math.min(entries.length, lo + limit);
	const page = entries.slice(lo, end);
	const last = page.at(-1);
	return end < entries.length && last !== undefined ? { entries: page, next_after: last.seq } : { entries: page };
}
