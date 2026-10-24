// ─── Reading-fit test passages (P11) ─────────────────────────────────────────
// Twelve short passages written for this project at a plain reading level,
// about 120 words each, with one fixed multiple-choice question. No page
// text and no model output is ever used in the test.

export interface FitPassage {
  id: string;
  title: string;
  paragraphs: string[];
  question: { prompt: string; options: [string, string, string, string]; answer: 0 | 1 | 2 | 3 };
}

export const FIT_PASSAGES: readonly FitPassage[] = [
  {
    id: "garden",
    title: "The roof garden",
    paragraphs: [
      "When the school ran out of space for a garden, the students looked up. The flat roof above the library was empty, so they asked if they could use it. The head teacher agreed, as long as an adult was always there.",
      "They carried up soil in buckets and built raised beds from old pallets. In the first spring they grew lettuce, beans and strawberries. The beans did best, climbing strings tied to the railings. Birds ate most of the strawberries, so the next year the students covered them with a net.",
      "Now the garden gives the school kitchen fresh salad twice a week in summer.",
    ],
    question: { prompt: "Which crop grew best in the first spring?", options: ["Lettuce", "Beans", "Strawberries", "Tomatoes"], answer: 1 },
  },
  {
    id: "bus",
    title: "The night bus",
    paragraphs: [
      "Maya works late at the hospital, so she takes the night bus home. It leaves from the stop outside the main gate at ten past midnight. The ride takes about forty minutes because the bus winds through every small street in the east of the city.",
      "Most nights the same driver is at the wheel. He keeps a flask of tea and a radio tuned to quiet music. Maya likes to sit near the front, where it is warm, and read on her phone.",
      "Last winter the bus was cancelled for a week because of snow. Maya shared a taxi with two nurses from her ward, and they split the fare three ways.",
    ],
    question: { prompt: "Why was the bus cancelled last winter?", options: ["The driver was ill", "There was snow", "The road was closed for repairs", "The hospital changed its hours"], answer: 1 },
  },
  {
    id: "library",
    title: "Borrowing tools",
    paragraphs: [
      "The town library has started lending more than books. On a shelf near the entrance there is now a row of tools: a drill, a ladder, a sewing machine and a pressure washer. Anyone with a library card can borrow one for a week, free of charge.",
      "The idea came from a woman who needed a drill only once, to hang a single shelf. She thought it was silly for every house on her street to own one. She asked the library, and the library asked for donations.",
      "The sewing machine is the most popular item. There is a waiting list of almost a month, so the library is looking for a second one.",
    ],
    question: { prompt: "Which item is borrowed most often?", options: ["The drill", "The ladder", "The sewing machine", "The pressure washer"], answer: 2 },
  },
  {
    id: "bread",
    title: "Baking bread",
    paragraphs: [
      "Sam learned to bake bread from his grandmother. She never measured anything, so at first his loaves came out flat and heavy. He started writing down every step and weighing the flour and water.",
      "He found that the dough needed more time than he expected. In his cold kitchen it took almost three hours to rise, not one. Once he waited long enough, the bread was light and soft inside, with a crisp crust.",
      "Now Sam bakes two loaves every Sunday morning. He keeps one and gives the other to his neighbour, who returns the favour with eggs from her hens.",
    ],
    question: { prompt: "What made Sam's bread turn out light?", options: ["Using more yeast", "Letting the dough rise longer", "Baking it hotter", "Buying a new oven"], answer: 1 },
  },
  {
    id: "river",
    title: "Cleaning the river",
    paragraphs: [
      "Every year in May, people in the village spend a Saturday cleaning the river. They meet at the old stone bridge at nine o'clock, collect gloves and bags, and spread out along both banks.",
      "Over the years they have found some strange things. Shopping trolleys are common, and so are tyres. Once, someone pulled out a rusty bicycle with a basket still full of plastic flowers.",
      "The amount of rubbish has dropped since the clean-up began. The first year, the group filled sixty bags. Last year they filled only twenty. A local café gives everyone free soup at lunchtime as a thank you.",
    ],
    question: { prompt: "How many bags did the group fill last year?", options: ["Ten", "Twenty", "Forty", "Sixty"], answer: 1 },
  },
  {
    id: "chess",
    title: "The chess club",
    paragraphs: [
      "Leo joined the chess club because his friend did. He knew how the pieces moved but lost every game in his first month. The club leader told him to stop trying to win quickly and to protect his pieces instead.",
      "Leo began to play more slowly. Before each move he asked himself one question: what is my opponent planning? His games got longer, and he started to draw against players who used to beat him easily.",
      "By the end of the year Leo won a small tournament at the town hall. His prize was a wooden chess set, which he now uses to teach his younger sister.",
    ],
    question: { prompt: "What did the club leader tell Leo to do?", options: ["Play faster", "Read chess books", "Protect his pieces", "Attack the queen first"], answer: 2 },
  },
  {
    id: "rain",
    title: "Saving rainwater",
    paragraphs: [
      "Priya's family put a large barrel under the drainpipe at the back of their house. When it rains, water runs off the roof and fills the barrel. A tap at the bottom lets them fill a watering can.",
      "In a wet month the barrel fills in two or three days. They use the water for the vegetable patch and for washing muddy boots. It is not safe to drink, so a sign on the barrel says so in large letters.",
      "Last summer there was a ban on garden hoses for six weeks. Priya's tomatoes survived because of the barrel, while many gardens nearby turned brown.",
    ],
    question: { prompt: "What is the rainwater NOT used for?", options: ["Watering vegetables", "Washing boots", "Drinking", "Filling a watering can"], answer: 2 },
  },
  {
    id: "market",
    title: "The Saturday market",
    paragraphs: [
      "The Saturday market fills the square from eight in the morning until two in the afternoon. There are about thirty stalls. Some sell fruit and cheese, others sell second-hand books, plants and handmade soap.",
      "Tomás runs the stall that repairs bicycles. He brings a toolbox, a pump and spare tyres. Most jobs take him less than fifteen minutes, so people leave their bikes and come back after shopping.",
      "When it rains, the market moves under the arches of the old town hall. There is less room there, so only twenty stalls can fit. The rest take turns, a different group each wet week.",
    ],
    question: { prompt: "Where does the market go when it rains?", options: ["Into a car park", "Under the town hall arches", "Inside the train station", "It is cancelled"], answer: 1 },
  },
  {
    id: "owl",
    title: "The owl box",
    paragraphs: [
      "Two years ago, the farmer at the end of the lane put a wooden box high up in her barn. It had a round hole at the front, just big enough for a barn owl. For a whole year nothing happened.",
      "Then one spring evening she saw a pale shape fly out of the hole. A pair of owls had moved in. By June there were four chicks, which hissed loudly whenever anyone came near.",
      "Owls eat mice and voles, so the farmer is happy to have them. She does not go near the box during the nesting season, and she has asked her visitors to keep their dogs on a lead.",
    ],
    question: { prompt: "How many chicks were there by June?", options: ["Two", "Three", "Four", "Six"], answer: 2 },
  },
  {
    id: "repair",
    title: "The repair café",
    paragraphs: [
      "Once a month, the church hall turns into a repair café. Volunteers sit at tables with tools, and people bring things that are broken: toasters, lamps, torn jackets and wobbly chairs.",
      "The volunteers do not just fix things. They show the owner how the repair is done, so that next time the owner might be able to do it alone. Many visitors are surprised by how simple most problems are. Often a loose wire or a worn-out fuse is all that is wrong.",
      "In its first year the café saved almost three hundred items from being thrown away. Tea and cake cost one pound, and the money pays for new tools.",
    ],
    question: { prompt: "What does the money from tea and cake pay for?", options: ["The hall rent", "New tools", "Volunteer wages", "Spare parts"], answer: 1 },
  },
  {
    id: "swim",
    title: "Learning to swim",
    paragraphs: [
      "Ana was thirty-five when she decided to learn to swim. She had always been afraid of deep water, so she booked lessons for adults at the local pool on Tuesday evenings.",
      "The first lessons took place in the shallow end. The teacher asked the group to put their faces in the water and blow bubbles. It felt silly, but it helped Ana breathe calmly. After six weeks she could float on her back without help.",
      "By the end of the course Ana swam a full length of the pool. She still prefers the shallow end, but she now goes swimming every weekend with her children.",
    ],
    question: { prompt: "What could Ana do after six weeks?", options: ["Dive from the board", "Float on her back", "Swim three lengths", "Teach her children"], answer: 1 },
  },
  {
    id: "bees",
    title: "Bees on the hospital roof",
    paragraphs: [
      "A hospital in the city keeps three beehives on its roof. A porter who kept bees as a hobby suggested the idea, and the hospital agreed as long as the hives stayed far from the windows.",
      "The bees fly to the park nearby and to the flowers on the balconies of the flats. In a good year the hives make about forty jars of honey. The jars are sold in the hospital shop, and the money goes to the children's ward.",
      "Patients can watch the hives on a screen in the waiting room. Many say it is the most relaxing thing to watch in the whole building.",
    ],
    question: { prompt: "Who suggested keeping bees on the roof?", options: ["A doctor", "A patient", "A porter", "The shop manager"], answer: 2 },
  },
];

export function passageWords(passage: FitPassage): number {
  return passage.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
}
