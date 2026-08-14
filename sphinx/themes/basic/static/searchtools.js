/*
 * Sphinx JavaScript utilities for the full-text search.
 */
"use strict";

/**
 * Simple result scoring code.
 */
if (typeof Scorer === "undefined") {
  var Scorer = {
    // Implement the following function to further tweak the score for each result
    // The function takes a result array [docname, title, anchor, descr, score, filename]
    // and returns the new score.
    /*
    score: result => {
      const [docname, title, anchor, descr, score, filename, kind] = result
      return score
    },
    */

    // query matches the full name of an object
    objNameMatch: 11,
    // or matches in the last dotted part of the object name
    objPartialMatch: 6,
    // Additive scores depending on the priority of the object
    objPrio: {
      0: 15, // used to be importantResults
      1: 5, // used to be objectResults
      2: -5, // used to be unimportantResults
    },
    //  Used when the priority is not in the mapping.
    objPrioDefault: 0,

    // query found in title
    title: 15,
    partialTitle: 7,
    // query found in terms
    term: 5,
    partialTerm: 2,
  };
}

// Global search result kind enum, used by themes to style search results.
// prettier-ignore
class SearchResultKind {
  static get index() { return "index"; }
  static get object() { return "object"; }
  static get text() { return "text"; }
  static get title() { return "title"; }
}

const _removeChildren = (element) => {
  while (element && element.lastChild) element.removeChild(element.lastChild);
};

/**
 * See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
 */
const _escapeRegExp = (string) =>
  string.replace(/[.*+\-?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string

const _escapeHTML = (text) => {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
};

const _displayItem = (item, searchTerms, highlightTerms) => {
  const docBuilder = DOCUMENTATION_OPTIONS.BUILDER;
  const docFileSuffix = DOCUMENTATION_OPTIONS.FILE_SUFFIX;
  const docLinkSuffix = DOCUMENTATION_OPTIONS.LINK_SUFFIX;
  const showSearchSummary = DOCUMENTATION_OPTIONS.SHOW_SEARCH_SUMMARY;
  const contentRoot = document.documentElement.dataset.content_root;

  const [docName, title, anchor, descr, score, _filename, kind] = item;

  let listItem = document.createElement("li");
  // Add a class representing the item's type:
  // can be used by a theme's CSS selector for styling
  // See SearchResultKind for the class names.
  listItem.classList.add(`kind-${kind}`);
  let requestUrl;
  let linkUrl;
  if (docBuilder === "dirhtml") {
    // dirhtml builder
    let dirname = docName + "/";
    if (dirname.match(/\/index\/$/))
      dirname = dirname.substring(0, dirname.length - 6);
    else if (dirname === "index/") dirname = "";
    requestUrl = contentRoot + dirname;
    linkUrl = requestUrl;
  } else {
    // normal html builders
    requestUrl = contentRoot + docName + docFileSuffix;
    linkUrl = docName + docLinkSuffix;
  }
  let linkEl = listItem.appendChild(document.createElement("a"));
  linkEl.href = linkUrl + anchor;
  linkEl.dataset.score = score;
  linkEl.innerHTML = _escapeHTML(title);
  if (descr) {
    listItem.appendChild(document.createElement("span")).innerHTML =
      ` (${_escapeHTML(descr)})`;
    // highlight search terms in the description
    if (SPHINX_HIGHLIGHT_ENABLED)
      // SPHINX_HIGHLIGHT_ENABLED is set in sphinx_highlight.js
      highlightTerms.forEach((term) =>
        _highlightText(listItem, term, "highlighted"),
      );
  } else if (showSearchSummary)
    fetch(requestUrl)
      .then((responseData) => responseData.text())
      .then((data) => {
        if (data)
          listItem.appendChild(
            Search.makeSearchSummary(data, searchTerms, anchor),
          );
        // highlight search terms in the summary
        if (SPHINX_HIGHLIGHT_ENABLED)
          // SPHINX_HIGHLIGHT_ENABLED is set in sphinx_highlight.js
          highlightTerms.forEach((term) =>
            _highlightText(listItem, term, "highlighted"),
          );
      });
  Search.output.appendChild(listItem);
};
const _finishSearch = (resultCount) => {
  Search.stopPulse();
  Search.title.innerText = _("Search Results");
  if (!resultCount)
    Search.status.innerText = Documentation.gettext(
      "Your search did not match any documents. Please make sure that all words are spelled correctly and that you've selected enough categories.",
    );
  else
    Search.status.innerText = Documentation.ngettext(
      "Search finished, found one page matching the search query.",
      "Search finished, found ${resultCount} pages matching the search query.",
      resultCount,
    ).replace("${resultCount}", resultCount);
};
const _displayNextItem = (
  results,
  resultCount,
  searchTerms,
  highlightTerms,
) => {
  // results left, load the summary and display it
  // this is intended to be dynamic (don't sub resultsCount)
  if (results.length) {
    _displayItem(results.pop(), searchTerms, highlightTerms);
    setTimeout(
      () => _displayNextItem(results, resultCount, searchTerms, highlightTerms),
      5,
    );
  }
  // search finished, update title and status message
  else _finishSearch(resultCount);
};
// Helper function used by query() to order search results.
// Each input is an array of [docname, title, anchor, descr, score, filename, kind].
// Order the results by score (in opposite order of appearance, since the
// `_displayNextItem` function uses pop() to retrieve items) and then alphabetically.
const _orderResultsByScoreThenName = (a, b) => {
  const leftScore = a[4];
  const rightScore = b[4];
  const leftTitle = a[1].toLowerCase();
  const rightTitle = b[1].toLowerCase();

  // Handle numeric titles first
  const leftIsNumeric = /^[\d\s>\/]+$/.test(leftTitle);
  const rightIsNumeric = /^[\d\s>\/]+$/.test(rightTitle);

  if (leftIsNumeric && !rightIsNumeric) return -1;
  if (!leftIsNumeric && rightIsNumeric) return 1;

  // If both titles are numeric, compare dates
  if (leftIsNumeric && rightIsNumeric) {
    const leftDateParts = leftTitle.split('>');
    const rightDateParts = rightTitle.split('>');

    if (leftDateParts.length === 2 && rightDateParts.length === 2) {
      const leftDateObj = createDateFromParts(leftDateParts);
      const rightDateObj = createDateFromParts(rightDateParts);

      if (!isNaN(leftDateObj) && !isNaN(rightDateObj)) {
        return leftDateObj - rightDateObj; // ascending; pop() below displays newest first
      }
    }
  }

  // Compare scores
  if (leftScore !== rightScore) {
    return leftScore - rightScore; // Direct score comparison
  }

  // If scores are equal, compare titles alphabetically (in reverse order,
  // since `_displayNextItem` pops from the end of the results array; this
  // makes equal-scoring matches display in alphabetical order)
  return rightTitle.localeCompare(leftTitle); // Using localeCompare for string comparison
};

// Helper function to create Date object from parts
const createDateFromParts = (dateParts) => {
  const year = parseInt(dateParts[0].trim());
  const [month, day] = dateParts[1].trim().split('/').map(Number);
  return new Date(year, month - 1, day); // month is 0-indexed
};

// Build a display title for a section result. When the section has its own
// heading (e.g. a date like `8/8` inside a year file such as `2026`), show it
// as `docTitle > sectionTitle` so users see exactly which entry matched and the
// sort hook (_orderResultsByScoreThenName) can parse `year>month/day`.
const _displayTitleFor = (file, anchor) => {
  const docTitle = Search._index.titles[file];
  if (anchor == null) return docTitle;
  const allTitles = Search._index.alltitles || {};
  for (const title of Object.keys(allTitles)) {
    for (const [f, id] of allTitles[title]) {
      if (f === file && id === anchor) {
        return `${docTitle} > ${title}`;
      }
    }
  }
  return docTitle;
};

/**
 * Default splitQuery function. Can be overridden in ``sphinx.search`` with a
 * custom function per language.
 *
 * The regular expression works by splitting the string on consecutive characters
 * that are not Unicode letters, numbers, underscores, or emoji characters.
 * This is the same as ``\W+`` in Python, preserving the surrogate pair area.
 */
if (typeof splitQuery === "undefined") {
  var splitQuery = (query) => query
    .split(/[^\p{Letter}\p{Number}_\p{Emoji_Presentation}]+/gu)
    .filter(term => term)  // remove remaining empty strings
}

/**
 * Search Module
 */
const Search = {
  _index: null,
  _queued_query: null,
  _pulse_status: -1,

getInnerHTML: (htmlString, anchor) => {
    const htmlElement = new DOMParser().parseFromString(htmlString, 'text/html');
    for (const removalQuery of [".headerlink", "script", "style"]) {
      htmlElement.querySelectorAll(removalQuery).forEach((el) => {
        el.remove();
      });
    }
    if (anchor) {
      const anchorContent = htmlElement.querySelector(`[role="main"] ${anchor}`);
      if (anchorContent) return anchorContent.innerHTML;

      console.warn(
        `Anchored content block not found. Sphinx search tries to obtain it via DOM query '[role=main] ${anchor}'. Check your theme or template.`,
      );
    }

    // if anchor not specified or not found, fall back to main content
    const docContent = htmlElement.querySelector('[role="main"]');
    if (docContent) return docContent.innerHTML;

    console.warn(
      "Content block not found. Sphinx search tries to obtain it via DOM query '[role=main]'. Check your theme or template.",
    );
    return "";
  },

  init: () => {
    const query = new URLSearchParams(window.location.search).get("q");
    document
      .querySelectorAll('input[name="q"]')
      .forEach((el) => (el.value = query));
    if (query) Search.performSearch(query);
  },

  loadIndex: (url) =>
    (document.body.appendChild(document.createElement("script")).src = url),

  setIndex: (index) => {
    Search._index = index;
    if (Search._queued_query !== null) {
      const query = Search._queued_query;
      Search._queued_query = null;
      Search.query(query);
    }
  },

  hasIndex: () => Search._index !== null,

  deferQuery: (query) => (Search._queued_query = query),

  stopPulse: () => (Search._pulse_status = -1),

  startPulse: () => {
    if (Search._pulse_status >= 0) return;

    const pulse = () => {
      Search._pulse_status = (Search._pulse_status + 1) % 4;
      Search.dots.innerText = ".".repeat(Search._pulse_status);
      if (Search._pulse_status >= 0) window.setTimeout(pulse, 500);
    };
    pulse();
  },

  /**
   * perform a search for something (or wait until index is loaded)
   */
  performSearch: (query) => {
    // create the required interface elements
    const searchText = document.createElement("h2");
    searchText.textContent = _("Searching");
    const searchSummary = document.createElement("p");
    searchSummary.classList.add("search-summary");
    searchSummary.innerText = "";
    const searchList = document.createElement("ul");
    searchList.setAttribute("role", "list");
    searchList.classList.add("search");

    const out = document.getElementById("search-results");
    Search.title = out.appendChild(searchText);
    Search.dots = Search.title.appendChild(document.createElement("span"));
    Search.status = out.appendChild(searchSummary);
    Search.output = out.appendChild(searchList);

    const searchProgress = document.getElementById("search-progress");
    // Some themes don't use the search progress node
    if (searchProgress) {
      searchProgress.innerText = _("Preparing search...");
    }
    Search.startPulse();

    // index already loaded, the browser was quick!
    if (Search.hasIndex()) Search.query(query);
    else Search.deferQuery(query);
  },

  _parseQuery: (query) => {
    // stem the search terms and add them to the correct list
    const stemmer = new Stemmer();
    const searchTerms = new Set();
    const excludedTerms = new Set();
    const highlightTerms = new Set();
    const objectTerms = new Set(splitQuery(query.toLowerCase().trim()));
    splitQuery(query.trim()).forEach((queryTerm) => {
      const queryTermLower = queryTerm.toLowerCase();

      // maybe skip this "word"
      // stopwords set is from language_data.js
      if (stopwords.has(queryTermLower) || queryTerm.match(/^\d+$/)) {
        // pure-number tokens do not take part in searching, but keep them for
        // highlighting so quoted phrases like "超重武者 大八-8" highlight "-8"
        if (queryTerm.match(/^\d+$/)) highlightTerms.add(queryTermLower);
        return;
      }

      // stem the word
      let word = stemmer.stemWord(queryTermLower);
      // select the correct list
      if (word[0] === "-") excludedTerms.add(word.substr(1));
      else {
        searchTerms.add(word);
        highlightTerms.add(queryTermLower);
      }
    });

    if (SPHINX_HIGHLIGHT_ENABLED) {
      // SPHINX_HIGHLIGHT_ENABLED is set in sphinx_highlight.js
      localStorage.setItem(
        "sphinx_highlight_terms",
        [...highlightTerms].join(" "),
      );
    }

    // console.debug("SEARCH: searching for:");
    // console.info("required: ", [...searchTerms]);
    // console.info("excluded: ", [...excludedTerms]);

    return [query, searchTerms, excludedTerms, highlightTerms, objectTerms];
  },

  /**
   * execute search (requires search index to be loaded)
   */
  _performSearch: (
    query,
    searchTerms,
    excludedTerms,
    highlightTerms,
    objectTerms,
  ) => {
    const filenames = Search._index.filenames;
    const docNames = Search._index.docnames;
    const titles = Search._index.titles;
    const allTitles = Search._index.alltitles;
    const indexEntries = Search._index.indexentries;

    // Collect multiple result groups to be sorted separately and then ordered.
    // Each is an array of [docname, title, anchor, descr, score, filename, kind].
    const normalResults = [];
    const nonMainIndexResults = [];

    _removeChildren(document.getElementById("search-progress"));

let queryLower = query.toLowerCase().trim();
    if (queryLower.startsWith('"') && queryLower.endsWith('"')) {
      queryLower = queryLower.substring(1, queryLower.length - 1);
    }

    const titleEntries = Object.entries(allTitles);
    const titleLowerMap = new Map(titleEntries.map(([title]) => [title.toLowerCase().trim(), title]));

    for (const [lowerTitle, originalTitle] of titleLowerMap) {
      if (lowerTitle.includes(queryLower)) {
        const foundTitles = allTitles[originalTitle];
        for (const [file, id] of foundTitles) {
          const score = Math.round(Scorer.title * queryLower.length / originalTitle.length);
          const boost = titles[file] === originalTitle ? 1 : 0; // add a boost for document titles
          normalResults.push([
            docNames[file],
            titles[file] !== originalTitle ? `${titles[file]} > ${originalTitle}` : originalTitle,
            id !== null ? "#" + id : "",
            null,
            score + boost,
            filenames[file],
            SearchResultKind.title,
          ]);
        }
      }
    }

    // search for explicit entries in index directives
const indexEntriesArray = Object.entries(indexEntries);
    const indexLowerMap = new Map(indexEntriesArray.map(([entry]) => [entry.toLowerCase(), entry]));

    for (const [lowerEntry, originalEntry] of indexLowerMap) {
      if (lowerEntry.includes(queryLower)) {
        const foundEntries = indexEntries[originalEntry];
        for (const [file, id, isMain] of foundEntries) {
          const score = Math.round(100 * queryLower.length / originalEntry.length);
          const result = [
            docNames[file],
            titles[file],
            id ? "#" + id : "",
            null,
            score,
            filenames[file],
            SearchResultKind.index,
          ];
          if (isMain) {
            normalResults.push(result);
          } else {
            nonMainIndexResults.push(result);
          }
        }
      }
    }

    // lookup as object
    objectTerms.forEach((term) =>
      normalResults.push(...Search.performObjectSearch(term, objectTerms)),
    );

    // lookup as search terms in fulltext
    normalResults.push(...Search.performSectionSearch(searchTerms, excludedTerms));

    // exact full-text substring match: every query (with or without quotes)
    // is matched verbatim against the per-section plain text shipped in the
    // index (`sectiontext`). This makes a quoted and an unquoted search agree,
    // catches phrases that the index-side tokenizer split into multiple words
    // (e.g. `千查万别` -> `千查` + `万别`) while staying exact, and mirrors the
    // whole-query normalization done on the Python side.
    const trimmed = query.trim();
    const quoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith('“') && trimmed.endsWith('”'));
    if (Search._index.sectiontext) {
      const fulltextResults = Search.performFulltextSearch(
        quoted ? trimmed : trimmed.replace(/^["'\s]+|["'\s]+$/g, ""),
      );
      normalResults.push(...fulltextResults);
      // when the exact substring matched, the weak per-word tokenizer search
      // below can only add noise (words of a longer phrase appearing separately
      // elsewhere); keep it only as a fallback so results stay consistent with
      // the quoted query. Deprioritize its hits by subtracting a constant so
      // exact matches (Scorer.term) always sort above partial token hits.
      if (fulltextResults.length > 0 && !quoted) {
        const deprioritize = (item) => {
          item[4] = Math.max(1, item[4] - 50);
          return item;
        };
        normalResults.forEach((item) => {
          if (item[6] === SearchResultKind.text && !fulltextResults.includes(item)) {
            deprioritize(item);
          }
        });
      }
    } else if (quoted && normalResults.length === 0 && nonMainIndexResults.length === 0) {
      // legacy index without sectiontext: fall back to bigram n-gram matching
      normalResults.push(...Search.performPhraseNgramSearch(trimmed));
    }

    // let the scorer override scores with a custom scoring function
    if (Scorer.score) {
      normalResults.forEach((item) => (item[4] = Scorer.score(item)));
      nonMainIndexResults.forEach((item) => (item[4] = Scorer.score(item)));
    }

    // Sort each group of results by score and then alphabetically by name.
    normalResults.sort(_orderResultsByScoreThenName);
    nonMainIndexResults.sort(_orderResultsByScoreThenName);

    // Combine the result groups in (reverse) order.
    // Non-main index entries are typically arbitrary cross-references,
    // so display them after other results.
    let results = [...nonMainIndexResults, ...normalResults];

    // remove duplicate search results
    // note the reversing of results, so that in the case of duplicates, the highest-scoring entry is kept
    let seen = new Set();
    results = results.reverse().reduce((acc, result) => {
      let resultStr = result
        .slice(0, 4)
        .concat([result[5]])
        .map((v) => String(v))
        .join(",");
      if (!seen.has(resultStr)) {
        acc.push(result);
        seen.add(resultStr);
      }
      return acc;
    }, []);

    return results.reverse();
  },

  query: (query) => {
    const [
      searchQuery,
      searchTerms,
      excludedTerms,
      highlightTerms,
      objectTerms,
    ] = Search._parseQuery(query);
    const results = Search._performSearch(
      searchQuery,
      searchTerms,
      excludedTerms,
      highlightTerms,
      objectTerms,
    );

    // for debugging
    //Search.lastresults = results.slice();  // a copy
    // console.info("search results:", Search.lastresults);

    // print the results
    _displayNextItem(results, results.length, searchTerms, highlightTerms);
  },

  /**
   * search for object names
   */
  performObjectSearch: (object, objectTerms) => {
    const filenames = Search._index.filenames;
    const docNames = Search._index.docnames;
    const objects = Search._index.objects;
    const objNames = Search._index.objnames;
    const titles = Search._index.titles;

    const results = [];

    const objectSearchCallback = (prefix, match) => {
      const name = match[4];
      const fullname = (prefix ? prefix + "." : "") + name;
      const fullnameLower = fullname.toLowerCase();
      if (fullnameLower.indexOf(object) < 0) return;

      let score = 0;
      const parts = fullnameLower.split(".");

      // check for different match types: exact matches of full name or
      // "last name" (i.e. last dotted part)
      if (fullnameLower === object || parts.slice(-1)[0] === object)
        score += Scorer.objNameMatch;
      else if (parts.slice(-1)[0].indexOf(object) > -1)
        score += Scorer.objPartialMatch; // matches in last name

      const objName = objNames[match[1]][2];
      const title = titles[match[0]];

      // If more than one term searched for, we require other words to be
      // found in the name/title/description
      const otherTerms = new Set(objectTerms);
      otherTerms.delete(object);
      if (otherTerms.size > 0) {
        const haystack = `${prefix} ${name} ${objName} ${title}`.toLowerCase();
        if (
          [...otherTerms].some((otherTerm) => haystack.indexOf(otherTerm) < 0)
        )
          return;
      }

      let anchor = match[3];
      if (anchor === "") anchor = fullname;
      else if (anchor === "-") anchor = objNames[match[1]][1] + "-" + fullname;

      const descr = objName + _(", in ") + title;

      // add custom score for some objects according to scorer
      if (Scorer.objPrio.hasOwnProperty(match[2]))
        score += Scorer.objPrio[match[2]];
      else score += Scorer.objPrioDefault;

      results.push([
        docNames[match[0]],
        fullname,
        "#" + anchor,
        descr,
        score,
        filenames[match[0]],
        SearchResultKind.object,
      ]);
    };
    Object.keys(objects).forEach((prefix) =>
      objects[prefix].forEach((array) => objectSearchCallback(prefix, array)),
    );
    return results;
  },

  /**
   * search for full-text terms in the index, returning matches at the
   * granularity of individual sections (each hit carries the section anchor).
   */
  performSectionSearch: (searchTerms, excludedTerms) => {
    const sections = Search._index.sections || [];
    const sectionterms = Search._index.sectionterms || {};
    const filenames = Search._index.filenames;
    const docNames = Search._index.docnames;

    // (file, anchor) -> { words: Map(word -> best score) }
    const sectionMap = new Map();

    searchTerms.forEach((word) => {
      // find the sections containing the query word in their text term index;
      // use Object.hasOwnProperty to avoid mismatching against prototype
      // properties, and add support for partial matches
      const matches = [];
      if (sectionterms.hasOwnProperty(word)) {
        matches.push({ ids: sectionterms[word], score: Scorer.term });
      } else if (word.length > 2) {
        const escapedWord = _escapeRegExp(word);
        Object.keys(sectionterms).forEach((term) => {
          if (term.match(escapedWord))
            matches.push({ ids: sectionterms[term], score: Scorer.partialTerm });
        });
      }

      // no match but word was a required one
      if (matches.length === 0) return;

      matches.forEach((match) => {
        match.ids.forEach((sectionId) => {
          const [file, anchor] = sections[sectionId];
          const key = file + "\0" + anchor;
          let record = sectionMap.get(key);
          if (record === undefined) {
            record = { file, anchor, words: new Map() };
            sectionMap.set(key, record);
          }
          const bestScore = record.words.get(word);
          if (bestScore === undefined || match.score > bestScore) {
            record.words.set(word, match.score);
          }
        });
      });
    });

    // as search terms with length < 3 are discarded
    const filteredTermCount = [...searchTerms].filter(
      (term) => term.length > 2,
    ).length;

    const results = [];
    for (const record of sectionMap.values()) {
      // require all search terms to be present in the same section (or all
      // terms with length >= 3, since short terms may be skipped)
      if (
        record.words.size !== searchTerms.size
        && record.words.size !== filteredTermCount
      )
        continue;

      // ensure that none of the excluded terms is in the same section
      if (
        [...excludedTerms].some((term) =>
          (sectionterms[term] || []).some(
            (sectionId) =>
              sections[sectionId][0] === record.file
              && sections[sectionId][1] === record.anchor,
          ),
        )
      )
        continue;

      const score = Math.max(...record.words.values());
      results.push([
        docNames[record.file],
        _displayTitleFor(record.file, record.anchor),
        record.anchor ? "#" + record.anchor : "",
        null,
        score,
        filenames[record.file],
        SearchResultKind.text,
      ]);
    }
    return results;
  },

  /**
   * Fallback search for phrases quoted with `"..."` that the term index
   * cannot match directly (the phrase was split into multiple words by the
   * index-side tokenizer, e.g. `千查万别` -> `千查` + `万别`).
   *
   * When the index ships per-section plain text (`sectiontext`), we perform an
   * exact substring match so that a quoted phrase only matches sections whose
   * text actually contains the full phrase.
   */
  performFulltextSearch: (phrase) => {
    const sections = Search._index.sections || [];
    const sectiontext = Search._index.sectiontext || [];
    const filenames = Search._index.filenames;
    const docNames = Search._index.docnames;

    const clean = phrase
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/[\uFF01-\uFF5E\u3000]/g, (ch) =>
        ch === "\u3000" ? " " : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0),
      )
      .toLowerCase();
    // mirror the Python-side normalization in sphinx.search: strip every
    // character that is not CJK / ASCII alnum so a phrase without any
    // formatting matches the contiguous run stored in `sectiontext`.
    const norm = clean.replace(/[^\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afa-z0-9]/g, "");
    if (!norm || norm.length < 2) return [];

    const results = [];
    for (let i = 0; i < sectiontext.length; i++) {
      if (sectiontext[i].includes(norm)) {
        const [file, anchor] = sections[i];
        results.push([
          docNames[file],
          _displayTitleFor(file, anchor),
          anchor ? "#" + anchor : "",
          null,
          Scorer.term,
          filenames[file],
          SearchResultKind.text,
        ]);
      }
    }
    return results;
  },

  performPhraseNgramSearch: (phrase) => {
    const sections = Search._index.sections || [];
    const sectionterms = Search._index.sectionterms || {};
    const filenames = Search._index.filenames;
    const docNames = Search._index.docnames;
    const titles = Search._index.titles;

    const clean = phrase.replace(/^["'\s]+|["'\s]+$/g, "");
    if (!clean || clean.length < 2) return [];

    // build the set of bigrams that exist as terms in the index
    const bigrams = new Set();
    for (let i = 0; i < clean.length - 1; i++) {
      const gram = clean.slice(i, i + 2);
      if (sectionterms.hasOwnProperty(gram)) bigrams.add(gram);
    }
    if (bigrams.size === 0) return [];

    // collect sections and how many distinct bigrams they contain
    const sectionHitCount = new Map(); // sectionId -> count of distinct bigrams
    const sectionWordScores = new Map(); // sectionId -> max term score
    bigrams.forEach((gram) => {
      sectionterms[gram].forEach((sectionId) => {
        sectionHitCount.set(sectionId, (sectionHitCount.get(sectionId) || 0) + 1);
        const cur = sectionWordScores.get(sectionId) || 0;
        sectionWordScores.set(sectionId, Math.max(cur, Scorer.term));
      });
    });

    // A phrase of length N has N-1 bigrams. Bigrams that are not present as
    // index terms at all cannot match, so the achievable maximum is
    // bigrams.size. Short phrases (card names) match with a looser ratio;
    // long phrases (effect text) need dense coverage so that only sections
    // actually containing most of the phrase survive.
    const ratio = clean.length <= 6 ? 0.6 : 0.8;
    const minHits = Math.max(2, Math.ceil(bigrams.size * ratio));
    const candidates = [];
    sectionHitCount.forEach((count, sectionId) => {
      if (count < minHits) return;
      const [file, anchor] = sections[sectionId];
      candidates.push([
        count,
        docNames[file],
        titles[file],
        anchor ? "#" + anchor : "",
        sectionWordScores.get(sectionId) || Scorer.partialTerm,
        filenames[file],
      ]);
    });
    // keep the most relevant sections (highest bigram coverage) and cap the
    // result size to avoid flooding the page with loose partial matches
    candidates.sort((a, b) => b[0] - a[0]);
    const results = candidates
      .slice(0, 50)
      .map(([count, docName, title, anchorStr, score, filename]) => [
        docName,
        title,
        anchorStr,
        null,
        score,
        filename,
        SearchResultKind.text,
      ]);
    return results;
  },

  /**
   * helper function to return a node containing the
   * search summary for a given text. keywords is a list
   * of stemmed words.
   */
  makeSearchSummary: (htmlText, keywords, anchor) => {
    const innerHTML = Search.getInnerHTML(htmlText, anchor);
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = innerHTML;

    const elements = tempContainer.querySelectorAll("p, div.line, h1, h2, h3, h4, h5, h6");
    const matchingLines = [];
    const keywordSet = new Set(Array.from(keywords).map(k => k.toLowerCase()));
    elements.forEach(element => {
      const textContent = element.textContent.trim();
      if (textContent) {
        if (Array.from(keywordSet).some(keyword => textContent.includes(keyword))) {
          matchingLines.push(element.innerHTML);
        }
      }
    });

    if (matchingLines.length === 0) return null;

    let summary = document.createElement("p");
    summary.classList.add("context");
    summary.innerHTML = "...<br>" + matchingLines.join("<br>...<br>") + "<br>...";

    return summary;
  },
};

_ready(Search.init);
