/** The state one companion-agents Pi session keeps across its event handlers. */

import { type Registry } from "./context.ts";
import { type Manifest } from "../../shared/compaction/manifest.ts";
import { type PolicyEnv, type PolicyFileRef, type PolicyState } from "./policy.ts";
import { type Profile } from "./profile.ts";
import { type Verdict as ReviewVerdict } from "../../shared/review/review.ts";

export interface Session {
	/** The id of this Pi session, from its manager: an inherited env var is not it. */
	id: string;
	profile: Profile;
	theme: string;
	registry: Registry;
	env: PolicyEnv;
	policy: PolicyState;
	refs: PolicyFileRef[];
	/** The read list is sent on the first run, and again after a compaction. */
	startupSent: boolean;
	reloadPending: boolean;
	/** The manifest saved before a compaction, sent once the summary lands. */
	manifest: Manifest | null;
	/** Review verdicts, by the key of the change they cover. */
	reviews: Map<string, ReviewVerdict>;
	/** Set when the owner chose to stop asking about commits this session. */
	skipReview: boolean;
}
