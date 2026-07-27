// Real quotes from tech pioneers, shown once per launch on the welcome
// banner. Every entry here was checked against multiple independent
// sources before inclusion — several plausible, extremely widely-quoted
// candidates were DROPPED after checking turned up that they predate their
// commonly-credited speaker (e.g. "a ship in port is safe" is John Shedd's,
// 1928 — Grace Hopper popularized it but didn't coin it; "ask forgiveness,
// not permission" is older than her too). Better to ship fewer, correctly
// attributed quotes than a longer list with a wrong name on one of them.
//
// That rule keeps earning itself. While expanding this list, a web search
// returned "Programs must be written for people to read" attributed to
// Barbara Liskov — it's from Abelson & Sussman's SICP (1985), and is
// credited to SICP below. Sources repeat each other's mistakes; check the
// primary one. Anything that couldn't be pinned to a real source (several
// nice-sounding Hedy Lamarr and Frances Allen lines) was left out rather
// than guessed at, which is why some obvious names are missing here.
//
// Where a quote has a citable origin, it's noted inline so the next person
// can re-check it without starting from scratch.

export interface Quote {
  text: string;
  author: string;
}

export const QUOTES: Quote[] = [
  { text: "The most dangerous phrase in the language is, 'We've always done it this way.'", author: "Grace Hopper" },
  { text: "I visualize a time when we will be to robots what dogs are to humans, and I'm rooting for the machines.", author: "Claude Shannon" },
  { text: "We can only see a short distance ahead, but we can see plenty there that needs to be done.", author: "Alan Turing" },
  { text: "The best way to predict the future is to invent it.", author: "Alan Kay" },
  { text: "Premature optimization is the root of all evil.", author: "Donald Knuth" },
  { text: "The question of whether a computer can think is no more interesting than the question of whether a submarine can swim.", author: "Edsger Dijkstra" },
  { text: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
  { text: "UNIX is basically a simple operating system, but you have to be a genius to understand the simplicity.", author: "Dennis Ritchie" },
  { text: "One of my most productive days was throwing away 1,000 lines of code.", author: "Ken Thompson" },
  { text: "This is for everyone.", author: "Tim Berners-Lee" },
  { text: "The more you buy, the more you save.", author: "Jensen Huang" },
  { text: "There was no second chance. We knew that.", author: "Margaret Hamilton" },
  { text: "Girls are capable of doing everything men are capable of doing. Sometimes they have more imagination than men.", author: "Katherine Johnson" },
  { text: "The Analytical Engine has no pretensions whatever to originate anything. It can do whatever we know how to order it to perform.", author: "Ada Lovelace" },

  // --- Added: people who moved computing forward, and opened it up. ---

  // EWD498, "How do we tell truths that might hurt?" (1975).
  { text: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  // NATO Software Engineering Conference (1969); repeated throughout the EWDs.
  { text: "Testing shows the presence, not the absence of bugs.", author: "Edsger Dijkstra" },
  // Brooks's Law — The Mythical Man-Month (1975).
  { text: "Adding manpower to a late software project makes it later.", author: "Fred Brooks" },
  // Epigrams on Programming, ACM SIGPLAN Notices (1982).
  { text: "A language that doesn't affect the way you think about programming is not worth knowing.", author: "Alan Perlis" },
  // Structure and Interpretation of Computer Programs, preface (1985).
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", author: "Abelson & Sussman, SICP" },
  // Her slogan, quoted widely in her own words; she built the IDF weighting
  // behind essentially every search engine.
  { text: "Computing is too important to be left to men.", author: "Karen Spärck Jones" },
  // Email to a DEC SRC list (1987), later folded into his distributed-systems writing.
  { text: "A distributed system is one in which the failure of a computer you didn't even know existed can render your own computer unusable.", author: "Leslie Lamport" },
  // A recurring theme of her Turing Award lecture on data abstraction (2009).
  { text: "Modularity based on abstraction is the way things get done.", author: "Barbara Liskov" },
  // His bootstrapping principle, from the Augmentation Research Center years.
  { text: "The better we get at getting better, the better we will be at getting better.", author: "Douglas Engelbart" },
  // Notes on Programming in C (1989), rule 5.
  { text: "Data dominates. If you've chosen the right data structures, the algorithms will almost always be self-evident.", author: "Rob Pike" },
  // The Zen of Python, PEP 20 (2004).
  { text: "Simple is better than complex.", author: "Tim Peters" },
  // On the web being royalty-free and open to all.
  { text: "The Web as I envisaged it, we have not seen it yet. The future is still so much bigger than the past.", author: "Tim Berners-Lee" },
];

export function pickRandomQuote(): Quote {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}
