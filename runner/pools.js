// Standardized, deliberately COMPLEX conversation pools — same shape for every
// vendor so the comparison stays apples-to-apples. Turns are compound, build on
// earlier answers, add constraints and objections, and probe edge cases — i.e.
// the kind of conversation a real, demanding shopper has, not one-line FAQs.
//
// IMPORTANT: no turn asks the assistant to "get a human" — so ANY handover the
// assistant initiates is unprompted, and the runner flags it as a red flag
// (a real capability limitation: it couldn't handle the conversation itself).

export const SUPPORT = [
  "Hi — I placed an order about 3 days ago (order #10472) and it still hasn't shipped. Can you tell me where it is and whether it's on track?",
  "I actually need it before this Saturday for a gift — is expedited shipping possible, and how much extra would that be?",
  "If I'm not home when it arrives, what happens — can it be left in a safe place or rescheduled without me paying again?",
  "One thing: can I still change the delivery address on that order, or is it too late now that it's been a few days?",
  "If I end up returning just one item from the order but keeping the rest, how does that work and who pays for return shipping?",
  "I paid part with a gift card and part on my credit card — if I return it, how is the refund split and how long does it take to land?",
  "What if the product arrives damaged or faulty — is that handled differently from a normal return?",
  "Do you price-match if the item goes on sale a few days after I buy it?",
  "I have a discount code that isn't applying at checkout — what are the usual reasons it would be rejected?",
  "Last thing — can I cancel or modify an order after it's placed, and is there a time window for that?",
];

// 10-turn sales-discovery conversations, adapted to each store's catalog.
// Shape: open ask -> rich needs+context -> budget/constraint -> compare two options
// -> objection/doubt -> secondary need -> bundle -> social proof -> add to cart -> total/promo.
export const SHOPPING = {
  sierra: [ // Casper — mattresses
    "Hi, I'm replacing a 10-year-old mattress and honestly don't know where to start — can you walk me through it?",
    "I run really hot at night, I'm a side-and-back sleeper with lower-back pain, and my partner is heavier than me and tosses a lot.",
    "I'd like to stay around $1,500 for a queen, ideally with financing.",
    "Can you compare the Snow and the Original for someone with my back issues — which actually supports better?",
    "I'm worried the Snow might be too soft and I'll sink in. How firm is it really?",
    "I'll also need pillows that sleep cool and won't go flat — what pairs well?",
    "Is there a bundle with the mattress, pillows and a protector that's cheaper than buying separately?",
    "Which of these is your best seller, and do people with back pain actually keep it after the trial?",
    "Okay, add the Snow in queen plus two cooling pillows to my cart.",
    "What's my total, how do the monthly financing payments look, and is there a promo running right now?",
  ],
  gorgias: [ // NouriVida — nutrition
    "Hi, I keep buying random supplements that don't work — can you help me actually pick the right thing?",
    "I'm training for a half marathon, I crash hard around 3pm, and I get jittery from too much caffeine.",
    "I'd prefer low sugar and ideally vegan, and I'm trying to keep it under about $60 a month.",
    "Can you compare the Matcha Meal Powder and the Energy Drink for steady afternoon energy without the crash?",
    "I'm skeptical these actually do anything different from coffee — what's actually in them that helps?",
    "I also sleep badly on training weeks — is there something for recovery and winding down at night?",
    "Is there a day-and-night bundle that's cheaper than buying them one by one?",
    "Which of these is your best seller, and do marathon trainers actually reorder it?",
    "Alright, add the Matcha Meal Powder and the night product to my cart.",
    "What's my total with the discount code, and is there a subscribe-and-save option?",
  ],
  siena: [ // Simple Modern — drinkware
    "Hi, I want one bottle that works for the gym, my desk and the car — can you help me choose?",
    "It needs to keep ice all day, survive being dropped, and not sweat all over my bag, and I have a small car cup holder.",
    "I'd like to stay under about $35 and ideally get it before next weekend.",
    "Can you compare the Mesa and the Trek for that mix of gym + car use — which lid is better?",
    "I've had 'leak-proof' bottles leak in my bag before — is the straw lid actually sealed when it tips over?",
    "I'd also want a matching one for my partner in a different color.",
    "Is there a 2-pack or bundle that's cheaper than buying two singles?",
    "Which size/style is your best seller, and do people say it really holds ice all day?",
    "Okay, add a 30oz in black and a 30oz in a lighter color to my cart.",
    "What's my total, and does that qualify for free shipping?",
  ],
  yuma: [ // EvryJewels — jewelry
    "Hi, I need a birthday gift for my girlfriend and I'm bad at picking jewelry — can you help?",
    "She wears dainty gold everyday pieces, nothing flashy, and she has quite sensitive skin so cheap metals turn her green.",
    "Budget is around $60 and I'd want it to arrive within a week.",
    "Should I go with a necklace or a bracelet for an everyday piece — which do people gift more?",
    "Is the gold solid or plated? I'm worried it'll tarnish or irritate her skin.",
    "If it goes well I'd want matching earrings too — do you have a set that goes together?",
    "Is there a gift bundle or set that's better value than buying pieces separately?",
    "Which necklace is your best seller for gifting, and does it come gift-wrapped?",
    "Okay, add your best-selling dainty gold necklace to my cart.",
    "What's my total with any current promo, and can it arrive by next Friday?",
  ],
  dg: [ // Bloom & Wild — flowers
    "Hi, I want to send flowers for my mum's birthday but I'm overwhelmed by the options — can you help me choose?",
    "She loves bright, cheerful arrangements, not roses, and she'll be at work so delivery timing matters.",
    "Budget around £40, and it needs to land on her actual birthday which is next Thursday.",
    "What's the difference between your letterbox flowers and the hand-tied bouquets for something that looks impressive?",
    "Will they actually arrive fresh and last at least a week, or do they show up wilted?",
    "I'd like to add a personal card message and maybe a small gift like chocolates.",
    "Is there a bundle with a vase or chocolates that's better value than adding them separately?",
    "Which bouquet is your most popular for birthdays, and do reviewers say it matched the photo?",
    "Okay, add your most popular birthday bouquet with the chocolates to my cart.",
    "What's my total including the Thursday delivery, and is there a discount for first orders?",
  ],
  meta: [ // Dermalogica — skincare
    "Hi, my skincare routine isn't working and I don't know what to change — can you help me rebuild it?",
    "My skin is dry and dull, I'm seeing fine lines around my eyes, and I react badly to strong actives.",
    "I'd like to keep it to two or three products and ideally under about $150 total.",
    "For my concerns, what's the difference between using a serum versus the futurecode booster — which does more?",
    "I'm worried a booster will be too harsh and break me out — is it okay for sensitive, reactive skin?",
    "I also need a daytime moisturizer with SPF that won't pill under makeup — what works with the booster?",
    "Is there a kit or bundle for dryness + fine lines that's cheaper than buying each one?",
    "Which product is your best seller for aging skin, and do reviewers with sensitive skin tolerate it?",
    "Okay, add the futurecode booster and the SPF moisturizer to my cart.",
    "What's my total, and is there a first-order offer or sample I can add?",
  ],
  ada: [ // Loop Earplugs — earplugs
    "Hi, I want earplugs but there are too many models — can you help me pick the right one?",
    "I need them for loud concerts, but also for focus in a noisy open-plan office, and I have small ears.",
    "Budget around €40, and I'd want them before a gig next weekend.",
    "Can you compare Experience and Quiet for that concert-plus-focus mix — how much do they each reduce?",
    "I'm worried they'll fall out when I'm moving around at a gig — do they actually stay in?",
    "I'd also like a carry case or accessory so I don't lose them.",
    "Is there a bundle that covers both the concert and focus use cases for less?",
    "Which pair is your best seller, and do reviewers say they're comfortable for hours?",
    "Okay, add the Experience 2 plus a case to my cart.",
    "What's my total with shipping, and will it arrive before the weekend?",
  ],
};
