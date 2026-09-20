"""Songs to add to the measurement corpus, with the key of the *recorded* master.

Why more songs at all: every gain measured so far came from fitting something to this corpus, and
both the fit and the measurement are limited by it. 167 songs puts a +/-0.8 point spread on a
cross-validated number, which is most of the size of the effects being chased, and it forces heavy
regularisation on every model because there is not enough data to support the parameters.

Rules followed here, the same ones the existing 106 rows were written under:

  * the key is the one the **recording** is in, not the one a chord sheet transposes it to
    (Sweet Child O' Mine is Db major);
  * songs whose tonic is genuinely contested are left out rather than guessed — Africa, Bohemian
    Rhapsody, Come As You Are, Black Hole Sun, Heart of Gold, The Sound of Silence;
  * these are deliberately **not** added to `src/data/verifiedKeys.json`. That file is what the app
    answers a player from, so a wrong row there is a user-facing bug; a wrong row here only adds
    noise to a fit.

Modal songs are labelled by their tonic and the nearer of the two modes, which is what the
note-set metric measures: Riders on the Storm is E dorian and sits here as E minor, one note away.
"""

NEW_ENTRIES = [
    # --- minor ---
    ("Alanis Morissette", "You Oughta Know", "F#", "minor"),
    ("No Doubt", "Don't Speak", "C", "minor"),
    ("Foo Fighters", "The Pretender", "A", "minor"),
    ("Evanescence", "Bring Me to Life", "E", "minor"),
    ("Nirvana", "Heart-Shaped Box", "A", "minor"),
    ("Weezer", "Say It Ain't So", "C", "minor"),
    ("Red Hot Chili Peppers", "Can't Stop", "E", "minor"),
    ("Red Hot Chili Peppers", "Otherside", "A", "minor"),
    ("Eminem", "Lose Yourself", "D", "minor"),
    ("Avicii", "Wake Me Up", "B", "minor"),
    ("Gorillaz", "Feel Good Inc.", "D", "minor"),
    ("Hozier", "Take Me to Church", "E", "minor"),
    ("Jimi Hendrix", "All Along the Watchtower", "C#", "minor"),
    ("Jimi Hendrix", "Voodoo Child (Slight Return)", "E", "minor"),
    ("Santana", "Oye Como Va", "A", "minor"),
    ("Santana", "Smooth", "A", "minor"),
    ("The Doors", "Riders on the Storm", "E", "minor"),
    ("The Doors", "Break On Through (To the Other Side)", "E", "minor"),
    ("America", "A Horse with No Name", "E", "minor"),
    ("Black Sabbath", "War Pigs", "E", "minor"),
    ("Iron Maiden", "Run to the Hills", "D", "minor"),
    ("Aerosmith", "Dream On", "F", "minor"),
    ("Bon Jovi", "You Give Love a Bad Name", "C", "minor"),
    ("Europe", "The Final Countdown", "F#", "minor"),
    ("Chic", "Le Freak", "A", "minor"),
    ("Stevie Wonder", "Higher Ground", "D#", "minor"),
    ("Ray Charles", "Hit the Road Jack", "F", "minor"),
    ("Fleetwood Mac", "Rhiannon", "A", "minor"),
    ("Michael Jackson", "Smooth Criminal", "A", "minor"),
    ("Prince", "When Doves Cry", "A", "minor"),
    ("Muse", "Uprising", "D", "minor"),
    ("Radiohead", "Street Spirit (Fade Out)", "A", "minor"),
    ("The Verve", "Bitter Sweet Symphony", "E", "minor"),
    ("Talking Heads", "Psycho Killer", "A", "minor"),
    ("Phil Collins", "In the Air Tonight", "D", "minor"),
    ("Kate Bush", "Running Up That Hill", "C", "minor"),
    ("Queen", "The Show Must Go On", "B", "minor"),
    ("Led Zeppelin", "Since I've Been Loving You", "C", "minor"),
    ("Led Zeppelin", "Dazed and Confused", "E", "minor"),
    ("Pearl Jam", "Even Flow", "E", "minor"),
    ("The Rolling Stones", "Gimme Shelter", "C#", "minor"),
    ("Eric Clapton", "Layla", "D", "minor"),
    ("B.B. King", "The Thrill Is Gone", "B", "minor"),
    ("Dolly Parton", "Jolene", "C#", "minor"),

    # --- major ---
    ("The Beatles", "Ticket to Ride", "A", "major"),
    ("The Beatles", "In My Life", "A", "major"),
    ("The Beatles", "Norwegian Wood (This Bird Has Flown)", "E", "major"),
    ("The Beatles", "Penny Lane", "B", "major"),
    ("The Beatles", "All You Need Is Love", "G", "major"),
    ("The Beatles", "Michelle", "F", "major"),
    ("The Beatles", "Get Back", "A", "major"),
    ("The Beatles", "Don't Let Me Down", "E", "major"),
    ("The Rolling Stones", "Sympathy for the Devil", "E", "major"),
    ("The Rolling Stones", "Wild Horses", "G", "major"),
    ("Led Zeppelin", "Ramble On", "E", "major"),
    ("Led Zeppelin", "Good Times Bad Times", "E", "major"),
    ("Pink Floyd", "Us and Them", "D", "major"),
    ("Pink Floyd", "Brain Damage", "D", "major"),
    ("Queen", "Under Pressure", "D", "major"),
    ("David Bowie", "Space Oddity", "C", "major"),
    ("David Bowie", "Heroes", "D", "major"),
    ("David Bowie", "Ziggy Stardust", "G", "major"),
    ("David Bowie", "Rebel Rebel", "D", "major"),
    ("Bruce Springsteen", "Born to Run", "E", "major"),
    ("Bruce Springsteen", "Dancing in the Dark", "B", "major"),
    ("Bruce Springsteen", "Born in the U.S.A.", "B", "major"),
    ("Tom Petty", "American Girl", "D", "major"),
    ("Tom Petty", "Learning to Fly", "F", "major"),
    ("Tom Petty", "Runnin' Down a Dream", "E", "major"),
    ("The Who", "Baba O'Riley", "F", "major"),
    ("The Who", "Won't Get Fooled Again", "A", "major"),
    ("The Who", "My Generation", "G", "major"),
    ("Cream", "Sunshine of Your Love", "D", "major"),
    ("Jimi Hendrix", "Purple Haze", "E", "major"),
    ("Jimi Hendrix", "Little Wing", "E", "major"),
    ("Jimi Hendrix", "Hey Joe", "E", "major"),
    ("Eagles", "Desperado", "G", "major"),
    ("Eagles", "Peaceful Easy Feeling", "E", "major"),
    ("Boston", "More Than a Feeling", "D", "major"),
    ("Van Halen", "Jump", "C", "major"),
    ("Guns N' Roses", "Paradise City", "G", "major"),
    ("Scorpions", "Wind of Change", "C", "major"),
    ("Poison", "Every Rose Has Its Thorn", "G", "major"),
    ("Pearl Jam", "Alive", "A", "major"),
    ("Pearl Jam", "Black", "E", "major"),
    ("Stone Temple Pilots", "Interstate Love Song", "E", "major"),
    ("The Smashing Pumpkins", "1979", "D#", "major"),
    ("The Smashing Pumpkins", "Today", "D#", "major"),
    ("Beck", "Loser", "D", "major"),
    ("Nirvana", "Lithium", "D", "major"),
    ("Foo Fighters", "Everlong", "D", "major"),
    ("Third Eye Blind", "Semi-Charmed Life", "F#", "major"),
    ("Smash Mouth", "All Star", "F#", "major"),
    ("blink-182", "All the Small Things", "C", "major"),
    ("Sublime", "What I Got", "D", "major"),
    ("4 Non Blondes", "What's Up?", "A", "major"),
    ("Red Hot Chili Peppers", "Under the Bridge", "D", "major"),
    ("Red Hot Chili Peppers", "Scar Tissue", "F", "major"),
    ("Death Cab for Cutie", "I Will Follow You into the Dark", "F", "major"),
    ("Kings of Leon", "Use Somebody", "C", "major"),
    ("Foster the People", "Pumped Up Kicks", "F", "major"),
    ("The Cure", "Just Like Heaven", "A", "major"),
    ("Pixies", "Where Is My Mind?", "E", "major"),
    ("Marvin Gaye", "What's Going On", "E", "major"),
    ("Marvin Gaye", "Let's Get It On", "D#", "major"),
    ("Otis Redding", "(Sittin' On) The Dock of the Bay", "G", "major"),
    ("Aretha Franklin", "Respect", "C", "major"),
    ("Stevie Wonder", "Isn't She Lovely", "E", "major"),
    ("Stevie Wonder", "Sir Duke", "B", "major"),
    ("Bill Withers", "Lean on Me", "C", "major"),
    ("Al Green", "Let's Stay Together", "G#", "major"),
    ("The Temptations", "My Girl", "C", "major"),
    ("James Brown", "I Got You (I Feel Good)", "D", "major"),
    ("Earth, Wind & Fire", "September", "A", "major"),
    ("The Jackson 5", "I Want You Back", "G#", "major"),
    ("Prince", "Purple Rain", "A#", "major"),
    ("Prince", "Kiss", "A", "major"),
    ("Post Malone", "Sunflower", "D", "major"),
    ("Post Malone", "Circles", "C", "major"),
    ("The Chainsmokers", "Closer", "G#", "major"),
    ("Daft Punk", "One More Time", "D", "major"),
    ("OutKast", "Hey Ya!", "G", "major"),
    ("Lewis Capaldi", "Someone You Loved", "D", "major"),
    ("My Chemical Romance", "Welcome to the Black Parade", "G", "major"),
    ("Green Day", "Wake Me Up When September Ends", "G", "major"),
    ("Bob Marley", "Three Little Birds", "A", "major"),
    ("Bob Marley", "Redemption Song", "G", "major"),
    ("Simon & Garfunkel", "Bridge Over Troubled Water", "D#", "major"),
    ("Elton John", "Tiny Dancer", "C", "major"),
    ("Elton John", "Bennie and the Jets", "G", "major"),
    ("Neil Young", "Old Man", "D", "major"),
    ("Buffalo Springfield", "For What It's Worth", "E", "major"),
    ("Creedence Clearwater Revival", "Proud Mary", "D", "major"),
    ("The Allman Brothers Band", "Ramblin' Man", "G", "major"),
    ("ZZ Top", "La Grange", "A", "major"),
    ("Louis Armstrong", "What a Wonderful World", "F", "major"),
    ("Etta James", "At Last", "F", "major"),
    ("Johnny Cash", "Ring of Fire", "G", "major"),
    ("Eric Clapton", "Tears in Heaven", "A", "major"),
    ("Eric Clapton", "Wonderful Tonight", "G", "major"),
    ("Stevie Ray Vaughan", "Pride and Joy", "E", "major"),
    ("John Mayer", "Gravity", "G", "major"),
    ("Norah Jones", "Don't Know Why", "A#", "major"),
]


def main():
    import json
    import pathlib

    repo = pathlib.Path(__file__).resolve().parents[2]
    path = repo / "src-tauri/tests/fixtures/corpus_labels.json"
    catalog = repo / "src/data/verifiedKeys.json"

    blob = json.loads(path.read_text())
    have = {
        (e["artist"].lower(), e["title"].lower())
        for e in blob["entries"] + json.loads(catalog.read_text())["entries"]
    }

    added = 0
    for artist, title, key, mode in NEW_ENTRIES:
        if (artist.lower(), title.lower()) in have:
            print(f"  already present: {artist} - {title}")
            continue
        blob["entries"].append(dict(artist=artist, title=title, key=key, mode=mode))
        have.add((artist.lower(), title.lower()))
        added += 1

    path.write_text(json.dumps(blob, indent=1, ensure_ascii=False) + "\n")
    majors = sum(1 for e in blob["entries"] if e["mode"] == "major")
    print(f"added {added}; corpus_labels.json now {len(blob['entries'])} rows "
          f"({majors} major / {len(blob['entries']) - majors} minor)")


if __name__ == "__main__":
    main()
