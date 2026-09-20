"""A second batch, minor keys only, to undo the imbalance the first one introduced.

`new_labels.py` added 143 songs but 99 of them were major, which pushed the corpus to 163/86. Mode
balance is not cosmetic here: the generative profile for each mode is fitted from that mode's clips
alone, so the minor profile would be estimated from half the data the major one gets, and the
tonic stage would be learning a boundary between a large class and a small one. The same rules
apply as in the first batch — recorded key, contested tonics left out, measurement corpus only.
"""

NEW_ENTRIES = [
    ("Dua Lipa", "New Rules", "A", "minor"),
    ("Camila Cabello", "Havana", "G", "minor"),
    ("Metallica", "The Unforgiven", "A", "minor"),
    ("Ozzy Osbourne", "Mr. Crowley", "D", "minor"),
    ("Led Zeppelin", "Babe I'm Gonna Leave You", "A", "minor"),
    ("Yes", "Roundabout", "E", "minor"),
    ("Rush", "Tom Sawyer", "E", "minor"),
    ("Heart", "Barracuda", "E", "minor"),
    ("Blue Öyster Cult", "(Don't Fear) The Reaper", "A", "minor"),
    ("The Doobie Brothers", "Long Train Runnin'", "G", "minor"),
    ("Herbie Hancock", "Chameleon", "A#", "minor"),
    ("Miles Davis", "So What", "D", "minor"),
    ("The Dave Brubeck Quartet", "Take Five", "D#", "minor"),
    ("Coldplay", "Trouble", "G", "minor"),
    ("Maroon 5", "This Love", "C", "minor"),
    ("Nancy Sinatra", "These Boots Are Made for Walkin'", "E", "minor"),
    ("The Mamas & the Papas", "California Dreamin'", "A", "minor"),
    ("The Turtles", "Happy Together", "F#", "minor"),
    ("The Zombies", "Time of the Season", "E", "minor"),
    ("Steppenwolf", "Born to Be Wild", "E", "minor"),
    ("Men at Work", "Down Under", "B", "minor"),
    ("Bee Gees", "Stayin' Alive", "F", "minor"),
    ("ABBA", "Gimme! Gimme! Gimme! (A Man After Midnight)", "D", "minor"),
    ("ABBA", "Money, Money, Money", "A", "minor"),
    ("Muse", "Time Is Running Out", "A", "minor"),
    ("Guns N' Roses", "Don't Cry", "A", "minor"),
    ("Iron Maiden", "Fear of the Dark", "D", "minor"),
    ("Gary Moore", "Still Got the Blues", "A", "minor"),
]

if __name__ == "__main__":
    import new_labels

    new_labels.NEW_ENTRIES = NEW_ENTRIES
    new_labels.main()
