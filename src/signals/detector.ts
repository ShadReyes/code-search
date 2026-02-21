import type { GitHistoryChunk } from '../types.js';
import type { SignalRecord, SignalDetector } from './types.js';

export class DetectorPipeline {
  private detectors: SignalDetector[];

  constructor(detectors: SignalDetector[]) {
    this.detectors = detectors;
  }

  run(commits: GitHistoryChunk[], existingSignals?: SignalRecord[]): SignalRecord[] {
    const allSignals: SignalRecord[] = existingSignals ? [...existingSignals] : [];

    for (const detector of this.detectors) {
      const found = detector.detect(commits, allSignals);
      if (found.length > 0) {
        console.log(`  [${detector.name}] detected ${found.length} signal${found.length > 1 ? 's' : ''}`);
        allSignals.push(...found);
      } else {
        console.log(`  [${detector.name}] no signals detected`);
      }
    }

    return existingSignals ? allSignals.slice(existingSignals.length) : allSignals;
  }

  /** For incremental: only runs windowed detectors (churn, ownership) on full commit set */
  runIncremental(
    _newCommits: GitHistoryChunk[],
    allCommits: GitHistoryChunk[],
    existingSignals: SignalRecord[],
    windowedDetectorNames: string[] = ['churn', 'ownership'],
  ): SignalRecord[] {
    const windowedDetectors = this.detectors.filter(d => windowedDetectorNames.includes(d.name));
    const pipeline = new DetectorPipeline(windowedDetectors);
    return pipeline.run(allCommits, existingSignals);
  }
}
