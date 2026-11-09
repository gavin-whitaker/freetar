/*****************
 * BEGIN SCROLL STUFF
 *****************/

const SCROLL_STEP_SIZE = 3;
const SCROLL_TIMEOUT_MINIMUM = 50;
const SCROLL_DELAY_AFTER_USER_ACTION = 500;

let pausedForUserInteraction = false;
let scrollTimeout = 500;
let scrollInterval = null;
let pauseScrollTimeout = null;

const checkboxAutoscroll = document.getElementById("checkbox_autoscroll");
if (checkboxAutoscroll) {
    checkboxAutoscroll.checked = false;
}


/*****************
* Event Handlers
*****************/

checkboxAutoscroll?.addEventListener("click", function () {
    if (this.checked) {
        startScrolling();
    } else {
        stopScrolling();
    }
});

window.addEventListener("wheel", () => {
    pauseScrolling(SCROLL_DELAY_AFTER_USER_ACTION);
});

window.addEventListener("touchmove", () => {
    pauseScrolling(SCROLL_DELAY_AFTER_USER_ACTION);
});

document.getElementById("scroll_speed_down")?.addEventListener("click", function () {
    // Increase the delay to slow down scroll
    scrollTimeout += 50;
    if (scrollInterval !== null)
    {
        pauseScrolling(SCROLL_DELAY_AFTER_USER_ACTION);
        startScrolling();
    }
});

document.getElementById("scroll_speed_up")?.addEventListener("click", function () {
    // Decrease the delay to speed up scroll.
    // Don't decrease the delay all the way to 0
    scrollTimeout = Math.max(SCROLL_TIMEOUT_MINIMUM, scrollTimeout - 50);

    if (scrollInterval !== null)
    {
        pauseScrolling(SCROLL_DELAY_AFTER_USER_ACTION);
        startScrolling();
    }
});


/*******************
 * Scroll Functions
 ******************/

// Scroll the page by SCROLL_STEP_SIZE
// Will not do anything if `pausedForUserInteraction` is set to `true`
function pageScroll() {
    if (pausedForUserInteraction) { return; }

    window.scrollBy(0, SCROLL_STEP_SIZE);
}

// Sets up the `pageScroll` function to be called in a loop every
// `scrollTimeout` milliseconds
function startScrolling() {
    document.getElementById("scroll_speed").innerHTML = (scrollTimeout / 50 - 10) * -1;
    if (scrollInterval) {
        clearInterval(scrollInterval);
    }
    scrollInterval = setInterval(pageScroll, scrollTimeout);
}

// Sets `pausedForUserInteraction` to `true` for `delay` milliseconds. 
// Will stop `pageScroll` from actually scrolling the page
function pauseScrolling(delay) {
    pausedForUserInteraction = true;
    clearTimeout(pauseScrollTimeout);
    pauseScrollTimeout = setTimeout(() => pausedForUserInteraction = false, delay);
}

// Clears the interval that got set up in `startScrolling`
function stopScrolling() {
    clearInterval(scrollInterval);
}


/*****************
 * DONE SCROLL STUFF
 *****************/

function colorize_favs() {
    // make every star yellow if we faved that tab before
    const favorites = JSON.parse(localStorage.getItem("favorites")) || {};

    document.querySelectorAll(".favorite[data-url]").forEach((el) => {
        if (el.getAttribute("data-url").split("?")[0] in favorites) {
            el.style.color = "#ffae00";
        }
    });
}

// Filter chips: `.type-filter[data-table]` buttons with `data-filter` filter rows by their `data-type`
function initialise_type_filter(filterEl) {
    const table = document.querySelector(filterEl.dataset.table);
    const rows = Array.from(table?.querySelectorAll("tbody tr") || []);
    const buttons = filterEl.querySelectorAll("[data-filter]");
    const emptyMessage = document.querySelector(filterEl.dataset.empty);
    if (!rows.length) return;

    buttons.forEach(btn => {
        const filter = btn.dataset.filter;
        const count = filter === "all" ? rows.length : rows.filter(r => r.dataset.type === filter).length;
        btn.querySelector(".count").textContent = `(${count})`;
        if (count === 0 && filter !== "all") btn.style.display = "none";

        btn.addEventListener("click", () => {
            buttons.forEach(b => {
                b.classList.toggle("btn-primary", b === btn);
                b.classList.toggle("btn-outline-primary", b !== btn);
            });
            let visible = 0;
            rows.forEach(row => {
                const show = filter === "all" || row.dataset.type === filter;
                row.style.display = show ? "" : "none";
                if (show) visible++;
            });
            if (emptyMessage) emptyMessage.style.display = visible ? "none" : "";
        });
    });
}

function initialise_transpose() {
    let transpose_value = 0;
    const transposedSteps = document.getElementById("transposed_steps");
    const minus = document.getElementById("transpose_down");
    const plus = document.getElementById("transpose_up");

    plus?.addEventListener("click", function () {
        transpose_value = Math.min(11, transpose_value + 1)
        transpose()
    });
    minus?.addEventListener("click", function () {
        transpose_value = Math.max(-11, transpose_value - 1)
        transpose()
    });
    transposedSteps?.addEventListener("click", function () {
        transpose_value = 0
        transpose()
    });

    document.querySelectorAll(".tab .chord-root, .tab .chord-bass").forEach((el) => {
        const text = el.textContent;
        el.setAttribute("data-original", text);
    });

    function transpose() {
        const originalKeyHint = document.getElementById("chords_original_key");
        if (originalKeyHint) {
            originalKeyHint.style.display = transpose_value === 0 ? "none" : "";
        }
        document.querySelectorAll(".tab .chord-root, .tab .chord-bass").forEach((el) => {
            const originalText = el.getAttribute("data-original");
            const transposedSteps = document.getElementById("transposed_steps");
            if (transpose_value === 0) {
                el.textContent = originalText;
                if (transposedSteps) {
                    transposedSteps.style.display = "none";
                }
            } else {
                const new_text = transpose_note(originalText.trim(), transpose_value);
                el.textContent = new_text;
                if (transposedSteps) {
                    transposedSteps.textContent = (transpose_value > 0 ? "+" : "") + transpose_value;
                    transposedSteps.style.display = "";
                }
            }
        });
        document.dispatchEvent(new CustomEvent("freetar:transpose", { detail: { steps: transpose_value } }));
    }

    // Defines a list of notes, grouped with any alternate names (like D# and Eb)
    const noteNames = [
        ['A'],
        ['A#', 'Bb'],
        ['B','Cb'],
        ['C', 'B#'],
        ['C#', 'Db'],
        ['D'],
        ['D#', 'Eb'],
        ['E', 'Fb'],
        ['F', 'E#'],
        ['F#', 'Gb'],
        ['G'],
        ['G#', 'Ab'],
    ];

    // Find the given note in noteNames, then step through the list to find the
    // next note up or down. Currently just selects the first note name that
    // matches. It doesn't preserve sharp, flat, or any try to determine what
    // key we're in.
    function transpose_note(note, transpose_value) {
        let noteIndex = noteNames.findIndex(tone => tone.includes(note));
        if (noteIndex === -1)
        {
            console.debug("Note ["+note+"] not found. Can't transpose");
            return note;
        }

        let new_index = (noteIndex + transpose_value) % 12;
        if (new_index < 0) {
            new_index += 12;
        }

        // TODO: Decide on sharp, flat, or natural
        return noteNames[new_index][0];
    }
}

document.addEventListener("DOMContentLoaded", function () {
    colorize_favs();
    initialise_transpose();
    document.querySelectorAll(".type-filter[data-table]").forEach(initialise_type_filter);
});


/*****************
 * CHORD DIAGRAMS
 *****************/

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
}

// shape: {name, frets, fingers, barres, base_fret}, strings ordered low E -> high e,
// frets are absolute (-1 = muted, 0 = open)
function renderChordDiagram(shape) {
    const left = 22, top = 24, stringGap = 13, fretGap = 17;
    const highestRow = Math.max(0, ...shape.frets.map(f => f - shape.base_fret + 1));
    const rows = Math.max(4, highestRow);
    const width = left + stringGap * 5 + 10;
    const height = top + fretGap * rows + 6;
    const right = left + stringGap * 5;
    const stringX = i => left + i * stringGap;
    const fretY = fret => top + (fret - shape.base_fret + 0.5) * fretGap;

    const svg = svgEl("svg", {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": `${shape.name} chord diagram`,
        fill: "currentColor",
        stroke: "currentColor",
        "font-family": "sans-serif",
    });

    for (let row = 0; row <= rows; row++) {
        const y = top + row * fretGap;
        const isNut = row === 0 && shape.base_fret === 1;
        svg.appendChild(svgEl("line", {x1: left, x2: right, y1: y, y2: y, "stroke-width": isNut ? 3 : 1}));
    }
    for (let i = 0; i < 6; i++) {
        svg.appendChild(svgEl("line", {x1: stringX(i), x2: stringX(i), y1: top, y2: top + rows * fretGap, "stroke-width": 1}));
    }
    if (shape.base_fret > 1) {
        svg.appendChild(svgEl("text", {
            x: left - 5, y: fretY(shape.base_fret) + 3.5, "font-size": 10, "text-anchor": "end", stroke: "none",
        }, `${shape.base_fret}fr`));
    }

    const barredStrings = new Set();
    for (const barre of shape.barres) {
        const x1 = stringX(barre.from), x2 = stringX(barre.to), y = fretY(barre.fret);
        svg.appendChild(svgEl("rect", {x: x1 - 5, y: y - 5, width: x2 - x1 + 10, height: 10, rx: 5, stroke: "none"}));
        for (let i = barre.from; i <= barre.to; i++) {
            if (shape.frets[i] === barre.fret) barredStrings.add(i);
        }
    }

    shape.frets.forEach((fret, i) => {
        const x = stringX(i);
        if (fret === -1) {
            svg.appendChild(svgEl("text", {x, y: top - 7, "font-size": 11, "text-anchor": "middle", stroke: "none"}, "×"));
        } else if (fret === 0) {
            svg.appendChild(svgEl("circle", {cx: x, cy: top - 10, r: 3.5, fill: "none", "stroke-width": 1.2}));
        } else if (!barredStrings.has(i)) {
            const y = fretY(fret);
            svg.appendChild(svgEl("circle", {cx: x, cy: y, r: 5.5, stroke: "none"}));
            if (shape.fingers[i] > 0) {
                svg.appendChild(svgEl("text", {
                    x, y: y + 3, "font-size": 8, "text-anchor": "middle", stroke: "none", style: "fill: var(--bs-body-bg)",
                }, shape.fingers[i]));
            }
        }
    });

    return svg;
}

// Same shape written as a strummed chord in tab notation, high e on top
function renderChordTab(shape) {
    const labels = ["E", "A", "D", "G", "B", "e"];
    const marks = shape.frets.map(f => (f === -1 ? "x" : String(f)));
    const width = Math.max(...marks.map(m => m.length));
    const lines = marks.map((mark, i) => `${labels[i]}|---${mark.padEnd(width, "-")}---|`).reverse();

    const pre = document.createElement("pre");
    pre.className = "chord-tab font-monospace";
    pre.textContent = lines.join("\n");
    return pre;
}

function initialise_chord_diagrams() {
    const container = document.getElementById("chordDiagrams");
    if (!container) return;

    for (const shape of JSON.parse(container.dataset.shapes)) {
        const card = document.createElement("div");
        card.className = "chord-card";
        const name = document.createElement("div");
        name.className = "chord-name";
        name.textContent = shape.name;
        card.append(name, renderChordDiagram(shape), renderChordTab(shape));
        container.appendChild(card);
    }

    const viewButtons = document.querySelectorAll("[data-chord-view]");
    const setView = (view) => {
        container.classList.toggle("tab-view", view === "tab");
        viewButtons.forEach(btn => {
            const active = btn.dataset.chordView === view;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-pressed", active);
        });
        localStorage.setItem("chord_view", view);
    };
    setView(localStorage.getItem("chord_view") || "tab");
    viewButtons.forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.chordView)));

    const toggle = document.getElementById("toggle_chords");
    const setExpanded = (expanded) => {
        container.style.display = expanded ? "" : "none";
        toggle.textContent = expanded ? "Hide" : "Show";
        toggle.setAttribute("aria-expanded", expanded);
        localStorage.setItem("chords_expanded", expanded);
    };
    setExpanded(JSON.parse(localStorage.getItem("chords_expanded") ?? "true"));
    toggle.addEventListener("click", () => setExpanded(container.style.display === "none"));
}

/*****************
 * PDF DOWNLOAD
 *****************/

// Print in light mode so dark-theme text doesn't vanish on white paper
let themeBeforePrint = null;
window.addEventListener("beforeprint", () => {
    themeBeforePrint = document.documentElement.getAttribute("data-bs-theme");
    document.documentElement.setAttribute("data-bs-theme", "light");
});
window.addEventListener("afterprint", () => {
    if (themeBeforePrint) {
        document.documentElement.setAttribute("data-bs-theme", themeBeforePrint);
    }
});

document.getElementById("download_pdf")?.addEventListener("click", () => window.print());

document.addEventListener("DOMContentLoaded", initialise_chord_diagrams);

document.getElementById("dark_mode")?.addEventListener("click", function () {
    if (document.documentElement.getAttribute('data-bs-theme') == 'dark') {
        document.documentElement.setAttribute('data-bs-theme', 'light');
        localStorage.setItem("dark_mode", false);
    } else {
        document.documentElement.setAttribute('data-bs-theme', 'dark');
        localStorage.setItem("dark_mode", true);
    }
});

document.querySelectorAll(".favorite").forEach((item) => {
    item.addEventListener("click", (event) => {
        const favorites = JSON.parse(localStorage.getItem("favorites")) || {};
        const elm = event.currentTarget;
        const tab_url = elm.getAttribute("data-url");
        if (tab_url in favorites) {
            delete favorites[tab_url];
            elm.style.color = "";
        } else {
            const fav = {
                artist_name: elm.getAttribute("data-artist"),
                song: elm.getAttribute("data-song"),
                type: elm.getAttribute("data-type"),
                rating: elm.getAttribute("data-rating"),
                tab_url: elm.getAttribute("data-url"),
            };
            favorites[fav["tab_url"]] = fav;
            elm.style.color = "#ffae00";
        }
        localStorage.setItem("favorites", JSON.stringify(favorites));
    });
});

const change_columns = (add) => {
    const tabs = document.querySelector(".tab");
    if (tabs) {
        tabs.style.columnCount = parseInt(tabs.style.columnCount || 1) + add;

        const down = document.querySelector("#columns_down");
        const up = document.querySelector("#columns_up");
        if (["", "1"].includes(tabs.style.columnCount)) {
            down.style.opacity = 0.3;
            down.style.pointerEvents = "none";
        } else if (["", "4"].includes(tabs.style.columnCount)) {
            up.style.opacity = 0.3;
            up.style.pointerEvents = "none";
        } else {
            down.style.opacity = 1;
            up.style.opacity = 1;
            down.style.pointerEvents = "auto";
            up.style.pointerEvents = "auto";
        }
    }
};

change_columns(0);
document.querySelector("#columns_up")?.addEventListener("click", () => change_columns(1));
document.querySelector("#columns_down")?.addEventListener("click", () => change_columns(-1));
