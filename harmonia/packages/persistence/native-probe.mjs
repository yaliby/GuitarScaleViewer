import { DatabaseSync } from 'node:sqlite';

/** Read the native library without modifying the database. Node-only diagnostic adapter. */
export function readNativeRecords(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare('SELECT record_json FROM saved_tracks WHERE analysis_id IS NOT NULL')
      .all()
      .map((row) => JSON.parse(row.record_json));
  } finally {
    database.close();
  }
}
