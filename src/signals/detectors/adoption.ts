import { createHash } from 'node:crypto';
import type { GitHistoryChunk } from '../../types.js';
import type { SignalRecord, SignalDetector } from '../types.js';

function signalId(type: string, ...parts: string[]): string {
  return createHash('sha256').update(type + parts.join(':')).digest('hex').slice(0, 16);
}

export class AdoptionCycleDetector implements SignalDetector {
  readonly name = 'adoption_cycle';

  detect(commits: GitHistoryChunk[]): SignalRecord[] {
    const signals: SignalRecord[] = [];

    // Look at file_diff chunks that touch package.json or config files
    const configDiffs = commits.filter(c =>
      c.chunk_type === 'file_diff' &&
      /package\.json$|\.config\.(ts|js|mjs)$|Gemfile$|requirements\.txt$/i.test(c.file_path)
    );

    if (configDiffs.length === 0) return signals;

    // Track dependency lifecycle from package.json diffs
    const depEvents = new Map<string, { event: 'add' | 'remove'; date: string; sha: string }[]>();

    for (const chunk of configDiffs) {
      if (!chunk.file_path.endsWith('package.json')) continue;
      const text = chunk.text;

      // Look for added dependencies in diff text
      const addMatches = text.matchAll(/\+\s*"([^"]+)":\s*"[^"]*"/g);
      for (const m of addMatches) {
        const dep = m[1];
        if (dep.startsWith('@types/') || dep === 'version' || dep === 'name') continue;
        if (!depEvents.has(dep)) depEvents.set(dep, []);
        depEvents.get(dep)!.push({ event: 'add', date: chunk.date, sha: chunk.sha });
      }

      // Look for removed dependencies
      const removeMatches = text.matchAll(/-\s*"([^"]+)":\s*"[^"]*"/g);
      for (const m of removeMatches) {
        const dep = m[1];
        if (dep.startsWith('@types/') || dep === 'version' || dep === 'name') continue;
        if (!depEvents.has(dep)) depEvents.set(dep, []);
        depEvents.get(dep)!.push({ event: 'remove', date: chunk.date, sha: chunk.sha });
      }
    }

    // Find dependencies with cycles (add → remove → add, or multiple add/remove transitions)
    for (const [dep, events] of depEvents) {
      if (events.length < 2) continue;

      // Sort by date
      events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Count transitions
      let transitions = 0;
      for (let i = 1; i < events.length; i++) {
        if (events[i].event !== events[i - 1].event) transitions++;
      }

      if (transitions < 2) continue; // Need at least 2 transitions (add→remove→add)

      const lastEvent = events[events.length - 1];
      const currentStatus = lastEvent.event === 'add' ? 'active' : 'removed';
      const cycleCount = Math.ceil(transitions / 2);

      signals.push({
        id: signalId('adoption_cycle', dep),
        type: 'adoption_cycle',
        summary: `${dep} has gone through ${cycleCount} adoption cycle${cycleCount > 1 ? 's' : ''}. Currently: ${currentStatus}. First seen: ${events[0].date.slice(0, 10)}.`,
        severity: cycleCount >= 3 ? 'warning' : 'caution',
        confidence: Math.min(0.85, 0.5 + transitions * 0.1),
        directory_scope: '.',
        contributing_shas: events.map(e => e.sha),
        temporal_scope: {
          start: events[0].date,
          end: lastEvent.date,
        },
        metadata: {
          subject: dep,
          cycle_count: cycleCount,
          transitions,
          current_status: currentStatus,
          events: events.map(e => ({ event: e.event, date: e.date, sha: e.sha.slice(0, 7) })),
        },
        created_at: new Date().toISOString(),
      });
    }

    return signals;
  }
}
