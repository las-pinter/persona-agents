/**
 * Agent profiles (platforms/pi/scripts/profile.ts).
 *
 * A profile is the identity of one Pi agent: what it may do, and which tools
 * it gets. These tests pin the two shipped profiles and the refusal of an
 * unknown id — a silently wrong profile is worse than a startup error.
 *
 * Run: node --experimental-strip-types --test tests/pi-profile.test.ts
 */

import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
	AGENT_PREFIX,
	DEFAULT_THEME,
	PROFILES,
	isAgentId,
	profileIds,
	profileOf,
	resolveProfile,
	SESSION_PROFILES,
} from "../platforms/pi/scripts/profile.ts";

describe("pi profiles: resolution", () => {
	test("an agent id is namespaced", () => {
		assert.equal(AGENT_PREFIX, "companion-agents:");
		assert.equal(isAgentId("companion-agents:companion"), true);
		assert.equal(isAgentId("companion"), false);
		assert.equal(isAgentId("Explore"), false);
	});

	test("the companion and the reviewer resolve", () => {
		assert.equal(profileOf("companion-agents:companion")?.name, "companion");
		assert.equal(profileOf("companion-agents:reviewer")?.name, "reviewer");
		assert.deepEqual(profileIds().sort(), ["companion-agents:companion", "companion-agents:reviewer"]);
	});

	test("a plain session resolves to no profile and stays unchanged", () => {
		for (const value of [undefined, null, "", "Explore", "general-purpose", "other-plugin:implementer"]) {
			assert.equal(resolveProfile(value), null, String(value));
		}
	});

	test("an unknown agent in our namespace throws and lists the known ones", () => {
		assert.throws(() => resolveProfile("companion-agents:nosuch"), /unknown agent "companion-agents:nosuch"/);
		assert.throws(() => resolveProfile("companion-agents:nosuch"), /companion-agents:companion, companion-agents:reviewer/);
	});

	test("one session profile is advertised, the reviewer stays a subagent", () => {
		assert.deepEqual(
			SESSION_PROFILES.map((profile) => profile.name),
			["companion"],
		);
	});
});

describe("pi profiles: capabilities", () => {
	test("the companion may write and holds the write tools", () => {
		const companion = PROFILES.companion;
		assert.equal(companion.writable, true);
		assert.equal(companion.persona, true);
		for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			assert.ok(companion.require.includes(tool), tool);
		}
		assert.deepEqual(companion.drop, []);
	});

	test("the reviewer is read-only and drops the write tools", () => {
		const reviewer = PROFILES.reviewer;
		assert.equal(reviewer.writable, false);
		assert.equal(reviewer.persona, false);
		// Bash stays: the reviewer runs the test suite once. The policy denies
		// every write it can see, so read-only holds two ways.
		assert.ok(reviewer.require.includes("bash"));
		assert.deepEqual([...reviewer.drop].sort(), ["edit", "write"]);
	});

	test("the id of a profile matches its key", () => {
		for (const [name, profile] of Object.entries(PROFILES)) {
			assert.equal(profile.name, name);
			assert.equal(profile.id, `${AGENT_PREFIX}${name}`);
		}
	});

	test("the default theme is the one the content tree ships first", () => {
		assert.equal(DEFAULT_THEME, "goblin");
	});
});
