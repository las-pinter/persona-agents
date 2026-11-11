/**
 * The permission vocabulary: one class union, one class list, one role-to-class
 * map, and one membership test for each.
 *
 * A class decides the rule set the gate applies to an agent. A class added here
 * fails the build at every place that must name it.
 */

/**
 * The permission class a role belongs to. The gate maps one class to one rule
 * set, so a wrong class grants the wrong fence.
 */
export type PermissionClass = "reader" | "worker" | "orchestrator";

export const PERMISSION_CLASSES: readonly PermissionClass[] = ["reader", "worker", "orchestrator"];

export type Role =
	| "orchestrator"
	| "planner"
	| "implementer"
	| "tester"
	| "reviewer"
	| "researcher"
	| "mascot";

/** The class of each role. A new profession must add a line here. */
export const ROLE_CLASS: Record<Role, PermissionClass> = {
	orchestrator: "orchestrator",
	planner: "reader",
	reviewer: "reader",
	researcher: "reader",
	mascot: "reader",
	implementer: "worker",
	tester: "worker",
};

/** True only for one of the three permission classes. */
export function isPermissionClass(value: string): value is PermissionClass {
	return (PERMISSION_CLASSES as readonly string[]).includes(value);
}

/** True only for one of the seven shipped professions. */
export function isRole(value: string): value is Role {
	return Object.prototype.hasOwnProperty.call(ROLE_CLASS, value);
}
