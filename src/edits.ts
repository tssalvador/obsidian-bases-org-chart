/*
 * Pure decisions behind the chart's edit actions. Most take the property's
 * current raw values (e.g. "[[Jane Doe]]") and a matcher that resolves a raw
 * value against the target, and return the new values to write.
 */

import { hasNote, primaryParents, type NotedNode, type OrgGraph, type OrgNode } from "./graph";

/** Make `link` the primary (first) value, keeping other dotted-line values that aren't the target. */
export function setPrimary(values: string[], link: string, isTarget: (raw: string) => boolean): string[] {
  return [link, ...values.slice(1).filter((v) => !isTarget(v))];
}

interface RemoveResult {
  remaining: string[];
  /** Whether anything matched. */
  removed: boolean;
  /** The value that becomes primary because the primary (first) one was removed, if any. */
  promoted: string | null;
}

/** Remove every value matching the target. */
export function removeParent(values: string[], isTarget: (raw: string) => boolean): RemoveResult {
  const remaining = values.filter((v) => !isTarget(v));
  const removed = remaining.length !== values.length;
  const wasPrimary = values.length > 0 && isTarget(values[0]);
  return { remaining, removed, promoted: wasPrimary && remaining.length ? remaining[0] : null };
}

interface LeavePlan {
  current: string[];
  /** New former values, or null when the former property needn't change. */
  former: string[] | null;
  alreadyFormer: boolean;
}

/**
 * Move `raw` out of `current` and into `former` (appended, original spelling
 * kept) unless it's already there. `former = null` means there's no former
 * property; the value is only removed.
 */
export function planLeave(
  current: string[],
  former: string[] | null,
  raw: string,
  same: (a: string, b: string) => boolean
): LeavePlan {
  const next = current.filter((v) => !same(v, raw));
  if (former === null) return { current: next, former: null, alreadyFormer: false };
  const alreadyFormer = former.some((v) => same(v, raw));
  return { current: next, former: alreadyFormer ? null : [...former, raw], alreadyFormer };
}

/**
 * New parent values for one of a leaver's reports when moving them to the
 * leaver's manager. `replacement` is that manager's link, or null when the
 * leaver had none. Returns null if the report doesn't list the leaver.
 *
 * - Leaver was the primary: the replacement takes the primary slot (and
 *   isn't repeated as a dotted line); with no replacement, the next dotted
 *   line is promoted.
 * - Leaver was only a dotted line: that line is dropped.
 */
export function planReassign(
  values: string[],
  isLeaver: (raw: string) => boolean,
  replacement: string | null,
  isReplacement: (raw: string) => boolean
): string[] | null {
  if (!values.some(isLeaver)) return null;
  const wasPrimary = isLeaver(values[0]);
  const rest = values.filter((v) => !isLeaver(v));
  if (!wasPrimary || replacement === null) return rest;
  return [replacement, ...rest.filter((v) => !isReplacement(v))];
}

/** Append `link` as a dotted-line (non-primary) value. Null if already listed. */
export function addDotted(values: string[], link: string, isTarget: (raw: string) => boolean): string[] | null {
  if (values.some(isTarget)) return null;
  return [...values, link];
}

/** Why a card can't be dropped onto another. */
export type DropProblem = "no note" | "self" | "already" | "loop";

/**
 * Why the dragged person can't report to `targetId`, or null if they can.
 * `person` gives their note, their main manager's note and everyone below
 * them through any reporting link (they can't become their own manager's
 * manager).
 */
export function dropProblem(
  graph: OrgGraph,
  targetId: string,
  person: { path: string; managerPath: string | null; below: ReadonlySet<string> }
): DropProblem | null {
  const target = graph.nodes.get(targetId);
  if (!target?.file) return "no note";
  if (target.file.path === person.path) return "self";
  if (target.file.path === person.managerPath) return "already";
  return person.below.has(targetId) ? "loop" : null;
}

/** A report's parent values now (`expected`) and after the move (`values`). */
export interface ReassignPlan {
  node: NotedNode;
  values: string[];
  expected: string[];
}

/**
 * New parent values for each current report of `leaverId` (main or dotted
 * line, with a note) when moving them to the leaver's own main manager (see
 * planReassign), sorted by name. `values` reads a report's parent values,
 * `linkTo` gives the link to a manager as written in a report's note, and
 * `refersTo` says whether a raw value in a report's note points at someone.
 */
export function reassignPlans(
  graph: OrgGraph,
  leaverId: string,
  deps: {
    values: (report: NotedNode) => string[];
    linkTo: (manager: OrgNode, report: NotedNode) => string;
    refersTo: (raw: string, person: OrgNode, report: NotedNode) => boolean;
  }
): ReassignPlan[] {
  const leaver = graph.nodes.get(leaverId);
  if (!leaver) return [];
  const managerId = primaryParents(graph).get(leaverId);
  const manager = managerId === undefined ? undefined : graph.nodes.get(managerId);
  const plans: ReassignPlan[] = [];
  for (const e of graph.edges) {
    if (e.from !== leaverId) continue;
    const report = graph.nodes.get(e.to);
    if (!hasNote(report) || report.former) continue;
    const expected = deps.values(report);
    const values = planReassign(
      expected,
      (raw) => deps.refersTo(raw, leaver, report),
      manager ? deps.linkTo(manager, report) : null,
      (raw) => (manager ? deps.refersTo(raw, manager, report) : false)
    );
    if (values) plans.push({ node: report, values, expected });
  }
  return plans.sort((a, b) => a.node.title.localeCompare(b.node.title));
}
