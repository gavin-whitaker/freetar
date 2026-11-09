import re
import unittest

from freetar.ug import STANDARD_TUNING, parse_tuning, render_tab_lines

STAFF = [
    "e|-----------------|",
    "B|--15-\\-13--------|",
    "G|----------12~~---|",
    "D|--0--3--------x4-|",
    "A|-----------------|",
    "E|-----------------|",
]


def notes(html_lines):
    pattern = r'<span class="tab-note" data-string="(\d)" data-fret="(\d+)" data-midi="(\d+)" data-col="([\d-]+)">'
    return [re.findall(pattern, line) for line in html_lines]


def visible(html):
    return re.sub(r'<[^>]+>', '', html).replace("&nbsp;", " ")


class TabParserTest(unittest.TestCase):
    def test_two_digit_frets_and_techniques(self):
        found = notes(render_tab_lines(STAFF))
        self.assertEqual(found[0], [])
        self.assertEqual([(s, f) for s, f, _, _ in found[1]], [("2", "15"), ("2", "13")])
        self.assertEqual([(s, f) for s, f, _, _ in found[2]], [("3", "12")])
        # the "4" after "x" is a repeat count, not a fret
        self.assertEqual([f for _, f, _, _ in found[3]], ["0", "3"])

    def test_midi_numbers(self):
        found = notes(render_tab_lines(STAFF))
        self.assertEqual(found[1][0][2], str(59 + 15))
        self.assertEqual(found[3][0][2], str(50 + 0))

    def test_overlapping_notes_share_a_column(self):
        found = notes(render_tab_lines(STAFF))
        # B string "15" (cols 3-4) and D string "0" (col 3) are played together
        self.assertEqual(found[1][0][3], found[3][0][3])
        self.assertNotEqual(found[1][1][3], found[3][1][3])

    def test_alignment_preserved(self):
        html = render_tab_lines(STAFF)
        self.assertEqual([visible(line) for line in html], STAFF)

    def test_non_staff_lines_untouched(self):
        lines = ["[Verse]", "Some lyric 12 here", "e|--3--|"]
        self.assertEqual(notes(render_tab_lines(lines)), [[], [], []])

    def test_tunings(self):
        self.assertEqual(parse_tuning(None), STANDARD_TUNING)
        self.assertEqual(parse_tuning("E A D G B E (Standard)"), STANDARD_TUNING)
        self.assertEqual(parse_tuning("D A D G B E (Drop D)"), (38, 45, 50, 55, 59, 64))
        self.assertEqual(parse_tuning("Eb Ab Db Gb Bb Eb (Half Step Down)"), (39, 44, 49, 54, 58, 63))
        self.assertEqual(parse_tuning("D G D G B D (Open G)"), (38, 43, 50, 55, 59, 62))

    def test_drop_d_midi(self):
        found = notes(render_tab_lines(["e|---|", "B|---|", "G|---|", "D|---|", "A|---|", "D|-0-|"],
                                       parse_tuning("D A D G B E")))
        self.assertEqual(found[5][0][2], "38")


if __name__ == "__main__":
    unittest.main()
