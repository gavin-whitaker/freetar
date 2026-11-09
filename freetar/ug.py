import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import json
import os
import re

from dataclasses import dataclass, field
from .utils import FreetarError

LOCAL_MODE = os.environ.get("FREETAR_LOCAL") == "1"
GUITAR_TYPES = ("Chords", "Tabs")
HIDDEN_TYPES = ("Pro", "Official", "Video", "Power", "Drum Tabs")
# MIDI note of each open string, low E first
STANDARD_TUNING = (40, 45, 50, 55, 59, 64)
NOTE_PITCH_CLASSES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
TAB_STAFF_LINE = re.compile(r'^\s*[A-Ga-g][#b]?\s*[|:]')
TAB_FRET = re.compile(r'\d+')
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/126.0.0.0 Safari/537.36",
}


@dataclass
class SearchResult:
    artist_name: str
    song_name: str
    tab_url: str
    artist_url: str
    _type: str
    version: int
    votes: int
    rating: float

    def __init__(self, data: str):
        self.artist_name = data["artist_name"]
        self.song_name = data["song_name"]
        self.tab_url = urlparse(data["tab_url"]).path
        self.artist_url = data["artist_url"]
        self._type = data["type"]
        self.version = data["version"]
        self.votes = int(data["votes"])
        self.rating = round(data["rating"], 1)

    def __repr__(self):
        return f"{self.artist_name} - {self.song_name} (ver {self.version}) ({self._type} {self.rating}/5 - {self.votes} votes)"


@dataclass
class SongDetail:
    tab: str
    artist_name: str
    song_name: str
    version: int
    difficulty: str
    capo: str
    tuning: str
    tab_url: str
    alternatives: list[SearchResult] = field(default_factory=list)

    def __init__(self, data: dict):
        self.tab = data["store"]["page"]["data"]["tab_view"]["wiki_tab"]["content"]
        self.artist_name = data["store"]["page"]["data"]["tab"]['artist_name']
        self.song_name = data["store"]["page"]["data"]["tab"]["song_name"]
        self.version = int(data["store"]["page"]["data"]["tab"]["version"])
        self._type = data["store"]["page"]["data"]["tab"]["type"]
        self.rating = int(data["store"]["page"]["data"]["tab"]["rating"])
        self.difficulty = data["store"]["page"]["data"]["tab_view"]["ug_difficulty"]
        self.appliciture = data["store"]["page"]["data"]["tab_view"]["applicature"]
        self.is_guitar = self._type in GUITAR_TYPES
        self.chord_shapes = []
        self.capo = None
        self.tuning = None
        self.string_midis = STANDARD_TUNING
        if type(data["store"]["page"]["data"]["tab_view"]["meta"]) is dict:
            self.capo = data["store"]["page"]["data"]["tab_view"]["meta"].get("capo")
            _tuning = data["store"]["page"]["data"]["tab_view"]["meta"].get("tuning")
            self.tuning = f"{_tuning['value']} ({_tuning['name']})" if _tuning else None
        self.string_midis = parse_tuning(self.tuning)
        self.capo_fret = int(self.capo) if str(self.capo or "").isdigit() else 0
        self.tab_url = data["store"]["page"]["data"]["tab"]["tab_url"]
        self.alternatives = []
        for alternative in data["store"]["page"]["data"]["tab_view"]["versions"]:
            if alternative.get("type", "") != "Official":
                self.alternatives.append(SearchResult(alternative))
        self.chord_order = list(dict.fromkeys(re.findall(r'\[ch\](.+?)\[/ch\]', self.tab)))
        self.fix_tab()

    def __repr__(self):
        return f"{self.artist_name} - {self.song_name}"

    def fix_tab(self):
        tab = self.tab.replace("\r\n", "\n").replace("[tab]", "").replace("[/tab]", "")
        lines = render_tab_lines(tab.split("\n"), self.string_midis)
        tab = "".join(f'<span class="tab-line">{line}</span><br/>' for line in lines)

        # (?P<root>[A-Ha-h](#|b)?) : Chord root is any letter A - H with an optional sharp or flat at the end
        # (?P<quality>[^[/]+)?  : Chord quality is anything after the root, but before the `/` for the base note
        # (?P<bass>/[A-Ha-h](#|b)?)? :  Chord quality is anything after the root, including parens in the case of 'm(maj7)'
        # tab = re.sub(r'\[ch\](?P<root>[A-Ga-g](#|b)?)(?P<quality>[#\w()]+)?(?P<bass>/[A-Ga-g](#|b)?)?\[\/ch\]', self.parse_chord, tab)
        tab = re.sub(r'\[ch\](?P<root>[A-Ha-h](#|b)?)(?P<quality>[^[/]+)?(?P<bass>/[A-Ha-h](#|b)?)?\[\/ch\]', self.parse_chord, tab)
        self.tab = tab

    def parse_chord(self, chord):
        root = '<span class="chord-root">%s</span>' % chord.group('root')
        quality = ''
        bass = ''
        if chord.group('quality') is not None:
            quality = '<span class="chord-quality">%s</span>' % chord.group('quality')
        if chord.group('bass') is not None:
            bass = '/<span class="chord-bass">%s</span>' % chord.group('bass')[1:]
        return '<span class="chord fw-bold">%s</span>' % (root + quality + bass)


def fetch_store(path: str, params: dict = None, tabs_host: bool = False, attempts: int = 3) -> dict:
    """Download a UG page and return its parsed `js-store` JSON.

    The proxy intermittently serves pages without `store.page.data` or fails with a
    connection error or 5xx, so retry those. 4xx (e.g. a song that doesn't exist) fails at once.
    """
    if LOCAL_MODE:
        host = "https://tabs.ultimate-guitar.com" if tabs_host else "https://www.ultimate-guitar.com"
        headers = REQUEST_HEADERS
    else:
        host = "https://tabs.proxy.freetar.de" if tabs_host else "https://proxy.freetar.de"
        headers = None

    data = None
    for attempt in range(attempts):
        last_attempt = attempt == attempts - 1
        try:
            resp = requests.get(host + path, params=params, headers=headers, timeout=15)
            resp.raise_for_status()
        except requests.exceptions.HTTPError:
            if resp.status_code < 500 or last_attempt:
                raise
            continue
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            if last_attempt:
                raise
            continue
        store = BeautifulSoup(resp.text, 'html.parser').find("div", {"class": "js-store"})
        if store is None:
            if last_attempt:
                raise FreetarError("Ultimate Guitar returned an unexpected page, please try again.")
            continue
        data = json.loads(store.attrs['data-content'])
        if "data" in data["store"]["page"]:
            return data
    return data


@dataclass
class Search:
    results: dict
    total_pages: int
    current_page: int

    def __init__(self, value: str, page: int):
        try:
            data = fetch_store("/search.php", params={"page": page, "search_type": "title", "value": value})
            self.results = self.get_results(data)
            self.total_pages = data['store']['page']['data']['pagination']['total']
            self.current_page = data['store']['page']['data']['pagination']['current']
            #print(json.dumps(data, indent=4))
        except requests.exceptions.RequestException:
            # don't print full URL here, in case of 404
            raise FreetarError(f"Could not find any chords for '{value}'.")
        except (KeyError, ValueError, AttributeError) as e:
            raise FreetarError(f"Could not search for chords: {e}") from e

    def get_results(self, data: object):
        results = data['store']['page']['data']['results']
        ug_results = []
        for result in results:
            _type = result.get("type")
            if _type and _type not in HIDDEN_TYPES:
                s = SearchResult(result)
                ug_results.append(s)
        return ug_results

    @property
    def grouped(self) -> list[dict]:
        groups = {}
        for result in self.results:
            key = (result.artist_name.lower(), result.song_name.lower(), result._type)
            groups.setdefault(key, []).append(result)

        grouped = []
        for versions in groups.values():
            versions.sort(key=version_score, reverse=True)
            grouped.append({"best": versions[0], "other_versions": versions[1:]})
        grouped.sort(key=lambda g: version_score(g["best"]), reverse=True)
        return grouped

    @property
    def page_window(self) -> list:
        """Page numbers to show in the pagination bar, with None marking a gap."""
        wanted = {1, self.total_pages}
        wanted.update(range(self.current_page - 2, self.current_page + 3))
        pages = sorted(p for p in wanted if 1 <= p <= self.total_pages)
        window = []
        for page in pages:
            if window and page - window[-1] > 1:
                window.append(None)
            window.append(page)
        return window


def version_score(result: SearchResult) -> float:
    # damp the rating of versions with few votes, so a 5/5 with 2 votes doesn't win
    return result.rating * result.votes / (result.votes + 10)


def parse_tuning(tuning: str) -> tuple:
    """Open string MIDI notes (low E first) for a UG tuning like "D A D G B E (Drop D)".

    Falls back to standard tuning when the value can't be read or looks implausible.
    """
    if not tuning:
        return STANDARD_TUNING
    names = re.findall(r'[A-G][#b]?', tuning.split("(")[0])
    if len(names) != 6:
        return STANDARD_TUNING

    def pitch_class(name):
        pc = NOTE_PITCH_CLASSES[name[0]]
        return (pc + (1 if name.endswith("#") else -1 if name.endswith("b") else 0)) % 12

    # lowest string: the octave closest to standard low E
    low_pc = pitch_class(names[0])
    midis = [min((low_pc + 12 * octave for octave in range(2, 5)), key=lambda m: abs(m - STANDARD_TUNING[0]))]
    for name in names[1:]:
        step = (pitch_class(name) - midis[-1]) % 12 or 12
        midis.append(midis[-1] + step)

    if any(abs(m - s) > 5 for m, s in zip(midis, STANDARD_TUNING)):
        return STANDARD_TUNING
    return tuple(midis)


def render_tab_lines(lines: list[str], string_midis: tuple = STANDARD_TUNING) -> list[str]:
    """Convert raw tab text lines to HTML, wrapping frets of 6-line tab staffs in `.tab-note` spans.

    Notes whose characters overlap horizontally are grouped into one column (`data-col`),
    i.e. they are played at the same time. Spans add no visible characters, so the
    monospace alignment of the staff is preserved.
    """
    notes_by_line = {}
    block_id = 0
    i = 0
    while i < len(lines):
        run = 0
        while i + run < len(lines) and TAB_STAFF_LINE.match(lines[i + run]):
            run += 1
        if run < 6:
            i += max(run, 1)
            continue
        for block_start in range(i, i + run - run % 6, 6):
            _mark_staff(lines, block_start, block_id, string_midis, notes_by_line)
            block_id += 1
        i += run

    html_lines = []
    for idx, line in enumerate(lines):
        notes = notes_by_line.get(idx)
        if not notes:
            html_lines.append(line.replace(" ", "&nbsp;"))
            continue
        parts, pos = [], 0
        for note in notes:
            parts.append(line[pos:note["start"]].replace(" ", "&nbsp;"))
            parts.append(
                f'<span class="tab-note" data-string="{note["string"]}" data-fret="{note["fret"]}" '
                f'data-midi="{note["midi"]}" data-col="{note["col"]}">{note["fret"]}</span>'
            )
            pos = note["end"]
        parts.append(line[pos:].replace(" ", "&nbsp;"))
        html_lines.append("".join(parts))
    return html_lines


def _mark_staff(lines, block_start, block_id, string_midis, notes_by_line):
    notes = []
    for offset in range(6):
        idx = block_start + offset
        line = lines[idx]
        staff_start = line.index("|") if "|" in line else line.index(":")
        string_index = 5 - offset  # top line of a staff is the high e string
        for match in TAB_FRET.finditer(line, staff_start + 1):
            fret_text = match.group()
            preceding = line[match.start() - 1] if match.start() > 0 else ""
            if len(fret_text) > 2 or int(fret_text) > 24 or preceding in "xX":
                continue
            notes.append({
                "line": idx,
                "start": match.start(),
                "end": match.end(),
                "string": 6 - string_index,  # guitar string number, 1 = high e
                "fret": int(fret_text),
                "midi": string_midis[string_index] + int(fret_text),
            })

    notes.sort(key=lambda n: n["start"])
    group, group_end = -1, -1
    for note in notes:
        if note["start"] >= group_end:
            group += 1
        group_end = max(group_end, note["end"]) if note["start"] < group_end else note["end"]
        note["col"] = f"{block_id}-{group}"
        notes_by_line.setdefault(note["line"], []).append(note)


def get_chord_shapes(s: SongDetail) -> list[dict]:
    """First fingering of every chord, in the order the chords appear in the song.

    UG lists strings high e first; shapes are returned low E first so they
    can be drawn left to right like a chord chart.
    """
    if not s.appliciture:
        return []

    names = [c for c in s.chord_order if c in s.appliciture]
    names += [c for c in s.appliciture if c not in names]

    shapes = []
    for name in names:
        variants = s.appliciture[name]
        if not variants:
            continue
        variant = variants[0]
        frets = variant["frets"][::-1]
        fingers = variant["fingers"][::-1]
        if len(frets) != 6:
            continue
        barres = [
            {
                "fret": capo["fret"],
                "from": 5 - capo["lastString"],
                "to": 5 - capo["startString"],
                "finger": capo.get("finger", 1),
            }
            for capo in variant.get("listCapos") or []
        ]
        pressed = [f for f in frets if f > 0]
        base_fret = 1 if not pressed or max(pressed) <= 4 else min(pressed)
        shapes.append({
            "name": name,
            "frets": frets,
            "fingers": fingers,
            "barres": barres,
            "base_fret": base_fret,
        })
    return shapes


def get_popular() -> list[SearchResult]:
    """All-time most viewed guitar tabs, most views first."""
    data = fetch_store("/explore", params={"order": "hitstotal_desc"})
    page = data["store"]["page"]["data"]["data"]
    hits = {h["id"]: h["hits"] for h in page.get("hits", [])}

    popular = []
    for tab in page["tabs"]:
        if tab.get("type") not in GUITAR_TYPES:
            continue
        result = SearchResult(tab)
        result.views = hits.get(tab["id"], 0)
        popular.append(result)
    popular.sort(key=lambda r: r.views, reverse=True)
    return popular


def ug_tab(url_path: str):
    try:
        data = fetch_store("/tab/" + str(url_path), tabs_host=True)
        s = SongDetail(data)
        if s.is_guitar:
            s.chord_shapes = get_chord_shapes(s)
        return s
    except (KeyError, ValueError, AttributeError, requests.exceptions.RequestException) as e:
        raise FreetarError(f"Could not parse chord: {e}") from e
