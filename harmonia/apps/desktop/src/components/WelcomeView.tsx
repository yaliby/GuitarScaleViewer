// @ts-nocheck
import { ArrowUpRight, AudioLines, FolderOpen } from 'lucide-react';
import type { AnalysisProfile, SavedTrack } from '../../../../packages/domain/types';
import { RecentSessions } from './LibraryView';
import { AnalysisProfilePicker } from './AnalysisProfilePicker';

export function WelcomeView({
  profile,
  records,
  onImport,
  onDemo,
  onProfile,
  onOpen,
}: {
  profile: AnalysisProfile;
  records: SavedTrack[];
  onImport: () => void;
  onDemo: () => void;
  onProfile: (profile: AnalysisProfile) => void;
  onOpen: (record: SavedTrack) => void;
}) {
  return (
    <>
      <section className="welcome">
        <div className="welcome-copy">
          <span className="eyebrow">
            <span className="tiny-dot" /> A NEW WAY INTO YOUR MUSIC
          </span>
          <h1>
            Hear the
            <br />
            whole <em>picture.</em>
          </h1>
          <p>
            Find the harmony beneath the surface.
            <br />
            Follow every chord. Make every moment your own.
          </p>
          <div className="welcome-actions">
            <button className="primary" onClick={onImport}>
              <FolderOpen size={18} /> Open a song
            </button>
            <button className="demo-button" onClick={onDemo}>
              Explore the demo <ArrowUpRight size={16} />
            </button>
          </div>
          <span className="supported">WAV, MP3, FLAC & more · drag a file anywhere</span>
        </div>
        <div className="welcome-illustration" aria-hidden="true">
          <div className="record-orbit orbit-one" />
          <div className="record-orbit orbit-two" />
          <div className="record-orbit orbit-three" />
          <div className="record-label">
            <span>FIND YOUR</span>
            <strong>harmony.</strong>
            <AudioLines size={48} strokeWidth={1} />
          </div>
          <span className="floating-note n1">Dm9</span>
          <span className="floating-note n2">G13</span>
          <span className="floating-note n3">Cmaj7</span>
        </div>
      </section>
      <div className="welcome-bottom">
        <div>
          <span className="eyebrow">THOUGHTFULLY LOCAL</span>
          <p>Your files. Your practice. Your space.</p>
        </div>
        <AnalysisProfilePicker profile={profile} onChange={onProfile} />
      </div>
      <RecentSessions records={records} onOpen={onOpen} />
    </>
  );
}
