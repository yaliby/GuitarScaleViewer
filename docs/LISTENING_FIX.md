# Missing chord ideas: diagnosis and fix

The running app recognized Spotify metadata but did not accept a key. Logs showed silent process capture first, then successful endpoint capture after fallback. Later analysis returned competing keys. Live Jam correctly withheld automatic application, but its empty state did not provide a useful explanation or a direct way to try the estimates.

Capture selection now prefers the matching active audio process instead of the first executable with the same name. Ambiguous helper processes and unrelated active applications trigger endpoint fallback. Session discovery initializes Windows COM on the calling engine thread, with balanced cleanup.

Live Jam now shows the audio collected and an explanation for paused playback, unavailable capture, silence, settling and competing keys. Up to three detected possibilities have explicit Try buttons. Selecting one opens the full map and chord ideas and turns automatic following off. Old-track possibilities are removed on track changes. No detection threshold was lowered.

Verification: 72 frontend tests; seven affected browser scenarios; 28 native unit tests plus two integration tests and five Python checks. Regression cases cover the Spotify helper-process selection and selecting an uncertain key to reveal chords. Production build and formatting checks pass. A real Windows player test received audible samples through endpoint fallback; process-isolated capture is not claimed as verified for every player. Key accuracy on arbitrary songs is not guaranteed.
