// @ts-nocheck
import type { AnalysisProfile } from '../../../../packages/domain/types';

export function AnalysisProfilePicker({
  profile,
  onChange,
}: {
  profile: AnalysisProfile;
  onChange: (profile: AnalysisProfile) => void;
}) {
  return (
    <label className="profile-picker">
      Analysis profile
      <select value={profile} onChange={(event) => onChange(event.target.value as AnalysisProfile)}>
        <option value="fast">Fast · DSP baseline</option>
        <option value="balanced">Balanced · DSP baseline</option>
        <option value="accurate">Experimental ML · guitar research</option>
      </select>
    </label>
  );
}
