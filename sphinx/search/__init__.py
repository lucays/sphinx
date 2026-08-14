"""Create a full-text search index for offline search."""

from __future__ import annotations

import dataclasses
import functools
import html
import json
import os
import pickle
import re
from importlib import import_module
from typing import TYPE_CHECKING

from docutils import nodes
from docutils.nodes import Element

from sphinx import addnodes, package_dir
from sphinx.util._pathlib import _StrPath
from sphinx.util.index_entries import split_index_msg

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Set
    from typing import Any, Protocol

    from docutils.nodes import Node

    from sphinx.environment import BuildEnvironment

    class _ReadableStream[T](Protocol):
        def read(self, n: int = ..., /) -> T: ...
        def readline(self, n: int = ..., /) -> T: ...

    class _WritableStream[T](Protocol):
        def write(self, s: T, /) -> object: ...


_NON_MINIFIED_JS_PATH = package_dir.joinpath('search', 'non-minified-js')
_MINIFIED_JS_PATH = package_dir.joinpath('search', 'minified-js')


class SearchLanguage:
    """This class is the base class for search natural language preprocessors.  If
    you want to add support for a new language, you should override the methods
    of this class.

    You should override `lang` class property too (e.g. 'en', 'fr' and so on).

    .. attribute:: stopwords

       This is a set of stop words of the target language.  Default `stopwords`
       is empty.  This word is used for building index and embedded in JS.

    .. attribute:: js_splitter_code

       Return splitter function of JavaScript version.  The function should be
       named as ``splitQuery``.  And it should take a string and return list of
       strings.

       .. versionadded:: 3.0

    .. attribute:: js_stemmer_code

       Return stemmer class of JavaScript version.  This class' name should be
       ``Stemmer`` and this class must have ``stemWord`` method.  This string is
       embedded as-is in searchtools.js.

       This class is used to preprocess search word which Sphinx HTML readers
       type, before searching index. Default implementation does nothing.
    """

    lang: str = ''
    language_name: str = ''
    stopwords: Set[str] = frozenset()
    js_splitter_code: str = ''
    js_stemmer_rawcode: str = ''
    js_stemmer_code = """
/**
 * Dummy stemmer for languages without stemming rules.
 */
var Stemmer = function () {
  this.stemWord = function (w) {
    return w;
  };
};
"""

    _word_re = re.compile(r'\w+')

    def __init__(self, options: dict[str, str]) -> None:
        """Initialize the class with the options the user has given."""
        self.options = options

    def split(self, input: str) -> list[str]:
        """This method splits a sentence into words.  Default splitter splits input
        at white spaces, which should be enough for most languages except CJK
        languages.
        """
        return self._word_re.findall(input)

    def stem(self, word: str) -> str:
        """This method implements stemming algorithm of the Python version.

        Default implementation does nothing.  You should implement this if the
        language has any stemming rules.

        This class is used to preprocess search words before registering them in
        the search index.  The stemming of the Python version and the JS version
        (given in the js_stemmer_code attribute) must be compatible.
        """
        return word

    def word_filter(self, word: str) -> bool:
        """Return true if the target word should be registered in the search index.
        This method is called after stemming.
        """
        return not word.isdigit() and word not in self.stopwords


# SearchEnglish imported after SearchLanguage is defined due to circular import
from sphinx.search.en import SearchEnglish  # NoQA: E402


def parse_stop_word(source: str) -> set[str]:
    """Collect the stopwords from a snowball style word list:

    .. code:: text

        list of space separated stop words | optional comment
    """
    result: set[str] = set()
    for line in source.splitlines():
        line = line.split('|')[0]  # remove comment
        result.update(line.split())
    return result


# maps language name to module.class or directly a class
languages: dict[str, str | type[SearchLanguage]] = {
    'da': 'sphinx.search.da.SearchDanish',
    'de': 'sphinx.search.de.SearchGerman',
    'en': SearchEnglish,
    'es': 'sphinx.search.es.SearchSpanish',
    'fi': 'sphinx.search.fi.SearchFinnish',
    'fr': 'sphinx.search.fr.SearchFrench',
    'hu': 'sphinx.search.hu.SearchHungarian',
    'it': 'sphinx.search.it.SearchItalian',
    'ja': 'sphinx.search.ja.SearchJapanese',
    'nl': 'sphinx.search.nl.SearchDutch',
    'no': 'sphinx.search.no.SearchNorwegian',
    'pt': 'sphinx.search.pt.SearchPortuguese',
    'ro': 'sphinx.search.ro.SearchRomanian',
    'ru': 'sphinx.search.ru.SearchRussian',
    'sv': 'sphinx.search.sv.SearchSwedish',
    'tr': 'sphinx.search.tr.SearchTurkish',
    'zh': 'sphinx.search.zh.SearchChinese',
}


class _JavaScriptIndex:
    """The search index as JavaScript file that calls a function
    on the documentation search object to register the index.
    """

    PREFIX = 'Search.setIndex('
    SUFFIX = ')'

    def dumps(self, data: Any) -> str:
        # keep CJK as raw UTF-8 instead of \uXXXX escapes: the per-section
        # full-text cache would otherwise inflate several-fold
        data_json = json.dumps(
            data, separators=(',', ':'), sort_keys=True, ensure_ascii=False
        )
        return self.PREFIX + data_json + self.SUFFIX

    def loads(self, s: str) -> Any:
        data = s[len(self.PREFIX) : -len(self.SUFFIX)]
        if not data or not s.startswith(self.PREFIX) or not s.endswith(self.SUFFIX):
            msg = 'invalid data'
            raise ValueError(msg)
        return json.loads(data)

    def dump(self, data: Any, f: _WritableStream[str]) -> None:
        f.write(self.dumps(data))

    def load(self, f: _ReadableStream[str]) -> Any:
        return self.loads(f.read())


js_index = _JavaScriptIndex()


def _is_meta_keywords(
    node: nodes.meta,
    lang: str | None,
) -> bool:
    if node.get('name') == 'keywords':
        meta_lang = node.get('lang')
        if meta_lang is None or meta_lang == lang:
            # lang not specified or matched to html_search_language
            return True

    return False


@dataclasses.dataclass
class WordStore:
    titles: list[tuple[str, str | None]] = dataclasses.field(default_factory=list)
    title_words: list[str] = dataclasses.field(default_factory=list)
    section_words: list[tuple[str, str | None]] = dataclasses.field(
        default_factory=list
    )
    # anchor -> concatenated plain text of that section (for full-text
    # substring search of quoted CJK phrases on the client side)
    section_text: dict[str | None, str] = dataclasses.field(default_factory=dict)


class WordCollector(nodes.NodeVisitor):
    """A special visitor that collects words for the `IndexBuilder`."""

    def __init__(self, document: nodes.document, lang: SearchLanguage) -> None:
        super().__init__(document)
        self.found_words: list[str] = []
        self.found_titles: list[tuple[str, str | None]] = []
        self.found_title_words: list[str] = []
        self.lang = lang

    def dispatch_visit(self, node: Node) -> None:
        if isinstance(node, nodes.comment):
            raise nodes.SkipNode
        elif isinstance(node, nodes.Element) and 'no-search' in node['classes']:
            # skip nodes marked with a 'no-search' class
            raise nodes.SkipNode
        elif isinstance(node, nodes.raw):
            if 'html' in node.get('format', '').split():
                # Some people might put content in raw HTML that should be searched,
                # so we just amateurishly strip HTML tags and index the remaining
                # content
                nodetext = re.sub(
                    r'<style.*?</style>',
                    '',
                    node.astext(),
                    flags=re.IGNORECASE | re.DOTALL,
                )
                nodetext = re.sub(
                    r'<script.*?</script>',
                    '',
                    nodetext,
                    flags=re.IGNORECASE | re.DOTALL,
                )
                nodetext = re.sub(r'<[^<]+?>', '', nodetext)
                self.found_words.extend(self.lang.split(nodetext))
            raise nodes.SkipNode
        elif isinstance(node, nodes.Text):
            self.found_words.extend(self.lang.split(node.astext()))
        elif isinstance(node, nodes.title):
            title = node.astext()
            if ids := node.parent['ids']:
                self.found_titles.append((title, ids[0]))
            else:
                self.found_titles.append((title, None))
            self.found_title_words.extend(self.lang.split(title))
        elif isinstance(node, Element) and _is_meta_keywords(node, self.lang.lang):  # type: ignore[arg-type]
            keywords = node['content']
            keywords = [keyword.strip() for keyword in keywords.split(',')]
            self.found_words.extend(keywords)


class IndexBuilder:
    """Helper class that creates a search index based on the doctrees
    passed to the `feed` method.
    """

    formats = {
        'json': json,
        'pickle': pickle,
    }

    def __init__(
        self, env: BuildEnvironment, lang: str, options: dict[str, str], scoring: str
    ) -> None:
        self._domains = env.domains
        self._env_version = env.version
        # docname -> title
        self._titles: dict[str, str | None] = env._search_index_titles
        # docname -> filename
        self._filenames: dict[str, str] = env._search_index_filenames
        # stemmed words in titles -> set(docname)
        self._title_mapping: dict[str, set[str]] = env._search_index_title_mapping
        # stemmed words -> set((docname, section anchor))
        self._section_mapping: dict[str, set[tuple[str, str | None]]] = (
            env._search_index_section_mapping
        )
        # docname -> all titles in document
        self._all_titles: dict[str, list[tuple[str, str | None]]] = (
            env._search_index_all_titles
        )
        # docname -> list(index entry)
        self._index_entries: dict[str, list[tuple[str, str, str]]] = (
            env._search_index_index_entries
        )
        # objtype -> index
        self._objtypes: dict[tuple[str, str], int] = env._search_index_objtypes
        # objtype index -> (domain, type, objname (localized))
        self._objnames: dict[int, tuple[str, str, str]] = env._search_index_objnames
        # docname -> anchor -> plain text of the section (for full-text
        # substring matching of quoted CJK phrases on the client side)
        self._section_text: dict[str, dict[str | None, str]] = {}
        # add language-specific SearchLanguage instance
        lang_class = languages.get(lang)

        # fallback; try again with language-code
        if lang_class is None and '_' in lang:
            lang_class = languages.get(lang.partition('_')[0])

        if lang_class is None:
            self.lang: SearchLanguage = SearchEnglish(options)
        elif isinstance(lang_class, str):
            module, classname = lang_class.rsplit('.', 1)
            lang_class: type[SearchLanguage] = getattr(import_module(module), classname)  # type: ignore[no-redef]
            self.lang = lang_class(options)  # type: ignore[operator]
        else:
            # it's directly a class (e.g. added by app.add_search_language)
            self.lang = lang_class(options)

        if scoring:
            with open(scoring, 'rb') as fp:
                self.js_scorer_code = fp.read().decode()
        else:
            self.js_scorer_code = ''
        self.js_splitter_code = ''

    def load(self, stream: _ReadableStream[str | bytes], format: Any) -> None:
        """Reconstruct from frozen data."""
        if isinstance(format, str):
            format = self.formats[format]
        frozen = format.load(stream)
        # if an old index is present, we treat it as not existing.
        if (
            not isinstance(frozen, dict)
            or frozen.get('envversion') != self._env_version
        ):
            msg = 'old format'
            raise ValueError(msg)
        index2fn = frozen['docnames']
        self._filenames = dict(zip(index2fn, frozen['filenames'], strict=True))
        self._titles = dict(zip(index2fn, frozen['titles'], strict=True))
        self._all_titles = {}

        for docname in self._titles:
            self._all_titles[docname] = []
        for title, doc_tuples in frozen['alltitles'].items():
            for doc, titleid in doc_tuples:
                self._all_titles[index2fn[doc]].append((title, titleid))

        def load_sections(
            mapping: dict[str, Any],
        ) -> dict[str, set[tuple[str, str | None]]]:
            rv: dict[str, set[tuple[str, str | None]]] = {}
            sections = frozen.get('sections', [])
            for k, section_ids in mapping.items():
                for section_id in section_ids:
                    file_idx, anchor = sections[section_id]
                    rv.setdefault(k, set()).add((index2fn[file_idx], anchor))
            return rv

        self._section_mapping = load_sections(frozen.get('sectionterms', {}))
        # restore the per-section plain-text cache so an incremental build can
        # keep the full-text data of unchanged documents
        sections = frozen.get('sections', [])
        sectiontext = frozen.get('sectiontext', [])
        self._section_text = {}
        for (file_idx, anchor), text in zip(sections, sectiontext):
            if text:
                self._section_text.setdefault(index2fn[file_idx], {})[anchor] = text
        # no need to load keywords/objtypes

    def dump(
        self, stream: _WritableStream[str] | _WritableStream[bytes], format: Any
    ) -> None:
        """Dump the frozen index to a stream."""
        if isinstance(format, str):
            format = self.formats[format]
        format.dump(self.freeze(), stream)

    def get_objects(
        self, fn2index: dict[str, int]
    ) -> dict[str, list[tuple[int, int, int, str, str]]]:
        rv: dict[str, list[tuple[int, int, int, str, str]]] = {}
        otypes = self._objtypes
        onames = self._objnames
        for domain in self._domains.sorted():
            sorted_objects = sorted(domain.get_objects())
            for fullname, dispname, type, docname, anchor, prio in sorted_objects:
                if docname not in fn2index:
                    continue
                if prio < 0:
                    continue
                fullname = html.escape(fullname)
                dispname = html.escape(dispname)
                prefix, _, name = dispname.rpartition('.')
                plist = rv.setdefault(prefix, [])
                try:
                    typeindex = otypes[domain.name, type]
                except KeyError:
                    typeindex = len(otypes)
                    otypes[domain.name, type] = typeindex
                    otype = domain.object_types.get(type)
                    if otype:
                        # use str() to fire translation proxies
                        onames[typeindex] = (
                            domain.name,
                            type,
                            str(domain.get_type_name(otype)),
                        )
                    else:
                        onames[typeindex] = (domain.name, type, type)
                if anchor == fullname:
                    shortanchor = ''
                elif anchor == type + '-' + fullname:
                    shortanchor = '-'
                else:
                    shortanchor = anchor
                plist.append((fn2index[docname], typeindex, prio, shortanchor, name))
        return rv

    def freeze(self) -> dict[str, Any]:
        """Create a usable data structure for serializing."""
        docnames, titles = zip(*sorted(self._titles.items()), strict=True)
        filenames = [self._filenames.get(docname) for docname in docnames]
        fn2index = {f: i for (i, f) in enumerate(docnames)}

        objects = self.get_objects(fn2index)  # populates _objtypes
        objtypes = {v: k[0] + ':' + k[1] for (k, v) in self._objtypes.items()}
        objnames = self._objnames

        alltitles: dict[str, list[tuple[int, str | None]]] = {}
        for docname, titlelist in sorted(self._all_titles.items()):
            for title, titleid in titlelist:
                alltitles.setdefault(title, []).append((fn2index[docname], titleid))

        index_entries: dict[str, list[tuple[int, str, bool]]] = {}
        for docname, entries in self._index_entries.items():
            for entry, entry_id, main_entry in entries:
                index_entries.setdefault(entry.lower(), []).append((
                    fn2index[docname],
                    entry_id,
                    main_entry == 'main',
                ))

        # section-level full-text index: word -> list of section identifiers.
        # Anchors tables are string-interning arrays so that a section anchor is
        # not repeated once per distinct word inside that section.
        unique_sections = {
            (fn2index[docname], anchor)
            for secs in self._section_mapping.values()
            for docname, anchor in secs
        }
        sections = sorted(
            unique_sections, key=lambda s: (s[0], s[1] is None, s[1] or '')
        )
        section_index = {section: i for i, section in enumerate(sections)}
        sectionterms: dict[str, list[int]] = {}
        for word, secs in sorted(self._section_mapping.items()):
            word_sections = sorted(
                {section_index[(fn2index[docname], anchor)] for docname, anchor in secs}
            )
            if word_sections:
                sectionterms[word] = word_sections

        sectiontext = []
        for file_idx, anchor in sections:
            sectiontext.append(
                self._section_text.get(docnames[file_idx], {}).get(anchor, '')
            )

        return {
            'docnames': docnames,
            'filenames': filenames,
            'titles': titles,
            'objects': objects,
            'objtypes': objtypes,
            'objnames': objnames,
            'sections': sections,
            'sectionterms': sectionterms,
            'sectiontext': sectiontext,
            'envversion': self._env_version,
            'alltitles': alltitles,
            'indexentries': index_entries,
        }

    def label(self) -> str:
        return f'{self.lang.language_name} (code: {self.lang.lang})'

    def prune(self, docnames: Iterable[str]) -> None:
        """Remove data for all docnames not in the list."""
        new_titles = {}
        new_alltitles = {}
        new_filenames = {}
        for docname in docnames:
            if docname in self._titles:
                new_titles[docname] = self._titles[docname]
                new_alltitles[docname] = self._all_titles[docname]
                new_filenames[docname] = self._filenames[docname]
        self._titles = new_titles
        self._filenames = new_filenames
        self._all_titles = new_alltitles
        for wordnames in self._title_mapping.values():
            wordnames.intersection_update(docnames)
        keep = set(docnames)
        self._section_mapping = {
            word: {(doc, anchor) for doc, anchor in sections if doc in keep}
            for word, sections in self._section_mapping.items()
        }
        self._section_mapping = {
            word: sections for word, sections in self._section_mapping.items() if sections
        }
        self._section_text = {
            docname: texts
            for docname, texts in self._section_text.items()
            if docname in keep
        }

    def feed(
        self,
        docname: str,
        filename: str | os.PathLike[str],
        title: str,
        doctree: nodes.document,
    ) -> None:
        """Feed a doctree to the index."""
        self._titles[docname] = title
        self._filenames[docname] = os.fspath(filename)

        word_store = self._word_collector(doctree)

        _filter = self.lang.word_filter
        _stem = self.lang.stem

        # memoise self.lang.stem
        @functools.cache
        def stem(word_to_stem: str) -> str:
            return _stem(word_to_stem).lower()

        self._all_titles[docname] = word_store.titles
        self._section_text[docname] = word_store.section_text

        for word in word_store.title_words:
            # add stemmed and unstemmed as the stemmer must not remove words
            # from search index.
            stemmed_word = stem(word)
            if _filter(stemmed_word):
                self._title_mapping.setdefault(stemmed_word, set()).add(docname)
            elif _filter(word):
                self._title_mapping.setdefault(word, set()).add(docname)

        for word, anchor in word_store.section_words:
            # add stemmed and unstemmed as the stemmer must not remove words
            # from search index.
            stemmed_word = stem(word)
            if not _filter(stemmed_word) and _filter(word):
                stemmed_word = word
            if _filter(stemmed_word):
                # skip words already covered by the (title) heading search
                if docname in self._title_mapping.get(stemmed_word, ()):
                    continue
                self._section_mapping.setdefault(stemmed_word, set()).add(
                    (docname, anchor)
                )

        # find explicit entries within index directives
        _index_entries: set[tuple[str, str, str]] = set()
        for node in doctree.findall(addnodes.index):
            for entry_type, value, target_id, main, _category_key in node['entries']:
                try:
                    result = split_index_msg(entry_type, value)
                except ValueError:
                    pass
                else:
                    target_id = target_id or ''
                    if entry_type in {'see', 'seealso'}:
                        _index_entries.add((result[0], target_id, main))
                    _index_entries |= {(x, target_id, main) for x in result}

        self._index_entries[docname] = sorted(_index_entries)

    def _word_collector(self, doctree: nodes.document) -> WordStore:
        word_store = WordStore()
        split = self.lang.split
        language = self.lang.lang
        _feed_visit_nodes(
            doctree, word_store=word_store, split=split, language=language
        )
        return word_store

    def context_for_searchtool(self) -> dict[str, Any]:
        if self.lang.js_splitter_code:
            js_splitter_code = self.lang.js_splitter_code
        else:
            js_splitter_code = self.js_splitter_code

        return {
            'search_language_stemming_code': self.get_js_stemmer_code(),
            'search_language_stop_words': json.dumps(sorted(self.lang.stopwords)),
            'search_scorer_tool': self.js_scorer_code,
            'search_word_splitter_code': js_splitter_code,
        }

    def get_js_stemmer_rawcodes(self) -> list[_StrPath]:
        """Returns a list of non-minified stemmer JS files to copy."""
        if self.lang.js_stemmer_rawcode:
            return [
                _StrPath(_NON_MINIFIED_JS_PATH / 'base-stemmer.js'),
                _StrPath(_NON_MINIFIED_JS_PATH / self.lang.js_stemmer_rawcode),
            ]
        else:
            return []

    def get_js_stemmer_rawcode(self) -> str | None:
        return None

    def get_js_stemmer_code(self) -> str:
        """Returns JS code that will be inserted into language_data.js."""
        if not self.lang.js_stemmer_rawcode:
            return self.lang.js_stemmer_code

        base_js_path = _MINIFIED_JS_PATH / 'base-stemmer.js'
        language_js_path = _MINIFIED_JS_PATH / self.lang.js_stemmer_rawcode
        # Derive the JS class name from the stemmer filename rather than
        # from language_name, since some languages reuse another language's
        # stemmer. For example, SearchChinese reuses english-stemmer.js,
        # which defines EnglishStemmer.
        stemmer_class = (
            self.lang.js_stemmer_rawcode.removesuffix('-stemmer.js')
            .title()
            .replace('_', '')
            .replace('-', '')
            + 'Stemmer'
        )
        return '\n'.join((
            base_js_path.read_text(encoding='utf-8'),
            language_js_path.read_text(encoding='utf-8'),
            f'window.Stemmer = {stemmer_class};',
        ))


def _feed_visit_nodes(
    node: nodes.Node,
    *,
    word_store: WordStore,
    split: Callable[[str], list[str]],
    language: str,
) -> None:
    if isinstance(node, nodes.comment):
        return
    elif isinstance(node, nodes.Element) and 'no-search' in node['classes']:
        # skip nodes marked with a 'no-search' class
        return
    elif isinstance(node, nodes.raw):
        if 'html' in node.get('format', '').split():
            # Some people might put content in raw HTML that should be searched,
            # so we just amateurishly strip HTML tags and index the remaining
            # content
            nodetext = re.sub(
                r'<style.*?</style>',
                '',
                node.astext(),
                flags=re.IGNORECASE | re.DOTALL,
            )
            nodetext = re.sub(
                r'<script.*?</script>',
                '',
                nodetext,
                flags=re.IGNORECASE | re.DOTALL,
            )
            nodetext = re.sub(r'<[^<]+?>', '', nodetext)
            words = split(nodetext)
            word_store.section_words.extend(
                _anchored_words(words, word_store)
            )
            if nodetext.strip():
                anchor = word_store.titles[-1][1] if word_store.titles else None
                word_store.section_text[anchor] = (
                    word_store.section_text.get(anchor, '')
                    + search_norm(nodetext)
                )
        return
    elif isinstance(node, nodes.meta) and _is_meta_keywords(node, language):
        keywords = [keyword.strip() for keyword in node['content'].split(',')]
        word_store.section_words.extend(
            _anchored_words(keywords, word_store)
        )
    elif isinstance(node, nodes.Text):
        text = node.astext()
        words = split(text)
        word_store.section_words.extend(_anchored_words(words, word_store))
        if text.strip():
            anchor = word_store.titles[-1][1] if word_store.titles else None
            word_store.section_text[anchor] = (
                word_store.section_text.get(anchor, '') + search_norm(text)
            )
    elif isinstance(node, nodes.title):
        title, is_main_title = node.astext(), len(word_store.titles) == 0
        ids = node.parent['ids']
        title_node_id = None if is_main_title else ids[0] if ids else None
        word_store.titles.append((title, title_node_id))
        word_store.title_words.extend(split(title))
    for child in node.children:
        _feed_visit_nodes(child, word_store=word_store, split=split, language=language)


def _anchored_words(
    words: list[str], word_store: WordStore
) -> list[tuple[str, str | None]]:
    anchor = word_store.titles[-1][1] if word_store.titles else None
    return [(word, anchor) for word in words]


_NON_INDEXABLE_CHARS = re.compile(
    r'[^\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afa-zA-Z0-9]'
)

_FULLWIDTH_TO_HALFWIDTH = {
    chr(i): chr(i - 0xFEE0) for i in range(0xFF01, 0xFF5F)
}
_FULLWIDTH_TO_HALFWIDTH['\u3000'] = ' '


def search_norm(text: str) -> str:
    """Normalize text for client-side substring matching.

    Trailing/leading and *inner* whitespace plus every punctuation mark are
    stripped so that a user searching a long effect sentence without any
    formatting (no `「」`, `『』`, RST link tails, spaces, ...) still matches
    against the stored contiguous run of CJK/ASCII characters. Full-width
    ASCII letters/digits are folded to half-width and everything is lowercased
    so that the index matches what the client normalizes queries to.
    """
    halfwidth = ''.join(_FULLWIDTH_TO_HALFWIDTH.get(ch, ch) for ch in text)
    return _NON_INDEXABLE_CHARS.sub('', halfwidth).lower()
