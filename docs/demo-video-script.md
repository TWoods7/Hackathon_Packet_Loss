# Demo video script (3 minutes)

The submission video must show the team name, project name, concept, execution, our decisions, and the technical challenges we overcame. It plays at the start of judging, so it should set up the Q&A: anything we mention here, a judge may ask about (answers are in [contributions-and-how-it-works.md](contributions-and-how-it-works.md)).

Narration is about 420 words, a comfortable 3-minute pace. Split the voice-over so everyone speaks; the suggested speaker is in brackets.

## Before recording

- Run `npm run dev` with both API keys in `.env`. Use a full-screen browser window, zoomed so the storm panel and search box are readable.
- **Pick the demo address in advance.** It should be inside an outage at **Major storm** with more than one restoration step and **high** confidence. The storm simulation is seeded, so the same address gives the same result every take.
- Record the screen first, then add the voice-over. **Cut out the wait while the assistant answers**, and say so in the video only if a judge could think it's instant (it isn't).
- Close other tabs, hide bookmarks, and don't show `.env` or DevTools.

## Script

| Time | On screen | Narration |
|---|---|---|
| **0:00-0:15** | Title card: *Packet Loss · Chat AEP*, then the map at Calm | **[Jonah]** "We're Packet Loss, and this is Chat AEP, an AI outage concierge for AEP's challenge. When a storm is coming, customers want four answers: will I lose power, for how long, what should I do, and will I be alerted. Chat AEP answers all four from AEP's real network and damage data." |
| **0:15-0:40** | Drag the **Storm strength** slider from Calm through Thunderstorm and Winter storm to **Major storm**. Hexagons turn orange and red; purple circles appear. | **[Taylor]** "Storms are named after real storms in this area's records, from a thunderstorm up to Helene's remnants and February 2025. Each level is an expected number of broken poles and wires. The heatmap is the forecast: expected hours without power, averaged over at least ten homes so no household is identifiable. The circles are one simulated storm, traced through AEP's network, all 117,000 customers, to the protective devices that trip." |
| **0:40-1:10** | Type the demo address and search. The chat opens with a short summary. Type: *"A big storm is coming. Will I lose power, and for how long?"* Show the answer (What we know / Our estimate / What you can do), then expand **How I got this**. | **[Jonah]** "A customer searches their address. Then they just ask. The assistant gives a risk band and a confidence level, high here because the address matched closely and these lines have real storm history. It gives a restoration range, not a promise, and explains why. Every number comes from a tool running our model; the AI explains, it never guesses." |
| **1:10-1:40** | Back to map. Click the outage circle to open the panel with its **restoration steps**. Then move **Repair crews** from 110 down to about 50 and tick **Roads blocked**; the steps' times and the heatmap update. | **[Andrew]** "Restoration follows how crews really work. Repairs closer to the substation come first, priority locations like hospitals jump the queue, and each step shows who gets power back. Repair times come from our job sheet built on AEP's labor workbook, with the 4.5 times indirect multiplier, access adders, and lunch breaks. Fewer crews or blocked roads, and the estimate updates." |
| **1:40-2:00** | Back to the chat. Click **Preview my alerts**. Scroll the four messages, then tick **I rely on powered medical equipment**; a phone call and priority line appear. | **[Alex]** "Customers who qualify get proactive alerts: before the storm, outage confirmed, estimate updated, and power restored, each short enough for one text. Declaring medical equipment adds a phone call and priority follow-up. We never infer that; the customer tells us." |
| **2:00-2:15** | Type: *"There's a downed line in my yard."* The red safety banner appears before the reply. Click **Talk to a person**; show the agent summary. | **[Alex]** "Safety doesn't depend on the AI. A downed line triggers a warning instantly, and one click hands off to a person with a summary, so the customer doesn't repeat themselves." |
| **2:15-2:45** | Quick cuts: the README's data pipeline section, `grid.json` in the browser showing only coordinates and chains, the old percentage slider vs. named levels, one big circle vs. small circles (screenshots). | **[Taylor]** "Our biggest challenges: first, linking AEP's separate files into one network, which we validated customer by customer. Second, privacy: the browser only gets rounded locations, never account or device IDs." **[Alex]** "Third, honest visuals. One circle per outage covered miles of empty land, so we split them; and a five-percent storm sounded like light rain but meant a winter storm, so we named storms instead." |
| **2:45-3:00** | Back to the map at Major storm, then the title card. | **[Jonah]** "Everything's labeled as simulation, with clear limits and a fallback when we can't predict reliably. Next we'd add a live weather feed and validate against new storms. We're Packet Loss. Thanks for watching." |

## Features this shows (checklist)

- [ ] Team name and project name (0:00)
- [ ] Named storm levels and the forecast heatmap (0:15)
- [ ] Simulated outages traced through the network (0:15)
- [ ] Address search, risk band, confidence, restoration range, explanation (0:40)
- [ ] Restoration steps, priority locations, crew and road controls (1:10)
- [ ] Preparation advice ("What you can do") (0:40)
- [ ] Alert eligibility and four proactive messages; declared medical need (1:40)
- [ ] Safety banner and human handoff (2:00)
- [ ] Privacy, technical challenges and how we solved them (2:15)
- [ ] Limitations, fallback, future work (2:45)

## If you're short on time

Cut in this order: the screenshot cuts at 2:15 (keep the narration over the live map), then the medical checkbox, then the crew slider (keep Roads blocked). Never cut the address question, the alert preview, or the challenges: the brief's minimum demo and the judging guide both ask for them.
