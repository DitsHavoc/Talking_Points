const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REQUESTED_PORT = process.env.PORT ? Number(process.env.PORT) : 0;
let ACTIVE_PORT = 0;
const BUILD_VERSION = '5.1.1';
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();



// Server-side classroom language filter. Browser edits cannot bypass it.
// V4.2 is deliberately stricter than a normal profanity filter: it also blocks
// sexual/scatological search bait and common schoolyard attempts to evade it.
const CLASSROOM_BLOCKED_WORDS = new Set([
  // Strong profanity / insults
  'fuck','fucks','fucker','fuckers','fucking','fucked','motherfucker','motherfuckers','motherfucking',
  'shit','shits','shitty','shite','bullshit','shithead','shitheads','shitface','shitfaces',
  'cunt','cunts','twat','twats','wank','wanks','wanked','wanking','wanker','wankers','bollocks',
  'bastard','bastards','prick','pricks','dick','dicks','dickhead','dickheads','cock','cocks','cockhead','cockheads',
  'arse','arses','arsehole','arseholes','asshole','assholes','bitch','bitches','slut','sluts','whore','whores',
  'pussy','pussies','tosser','tossers','bellend','bellends','knobhead','knobheads','douche','douchebag','douchebags',

  // Scatological / bodily-function bait
  'poo','poos','pooed','pooing','poop','poops','pooped','pooping','poopy','poopoo',
  'piss','pisses','pissed','pissing','pee','pees','peed','peeing','urine','turd','turds','crap','crappy','diarrhea','diarrhoea',
  'vomit','vomiting','puke','puking','fart','farts','farting','shart','sharts','sharting',

  // Sexual terms / explicit anatomy
  'cum','cums','cummed','cumming','cumshot','cumshots','jizz','jizzed','jizzing','semen','sperm','spunk',
  'penis','penises','vagina','vaginas','vulva','vulvas','anus','anuses','scrotum','testicle','testicles','testes',
  'boob','boobs','boobie','boobies','tits','tit','titty','titties','nipples','nipple','erection','erections','boner','boners',
  'dildo','dildos','vibrator','vibrators','fleshlight','fleshlights','buttplug','buttplugs','ballsack','nutsack','foreskin','clit','clitoris','labia','cameltoe','queef','queefing','smegma',
  'blowjob','blowjobs','handjob','handjobs','rimjob','rimjobs','deepthroat','deepthroating','masturbate','masturbating','masturbation','ejaculate','ejaculates','ejaculating','ejaculation',
  'orgasm','orgasms','orgy','orgies','anal','gangbang','gangbangs','bukkake','creampie','creampies','facial','facials','threesome','milf','gilf','incest','bestiality',
  'horny','sex','sexy','sexting','sext','sexts','69','rule34','onlyfans','rape','raped','raping','rapist','rapists','molest','molested','molesting','molester','molesters','pedo','pedos','paedo','paedos','pedophile','pedophiles','paedophile','paedophiles',

  // Pornographic search terms
  'porn','porno','pornography','pornhub','xvideos','xnxx','redtube','youporn','hentai','ecchi','nudes','nude','naked','nsfw','sexcam','sextape','sextapes',

  // Slurs / discriminatory abuse
  'fag','fags','faggot','faggots','nigger','niggers','nigga','niggas',
  'retard','retards','retarded','spastic','spastics','nonce','nonces'
]);

// Patterns catch inflections and common variants without doing unsafe substring
// matching inside innocent words (e.g. Dickinson / Scunthorpe remain allowed).
const CLASSROOM_BLOCKED_TOKEN_PATTERNS = [
  /^f+u+c+k+(?:s|er|ers|ed|ing)?$/,
  /^s+h+i+t+(?:s|ty|ted|ting|head|heads|face|faces)?$/,
  /^c+u+n+t+s?$/,
  /^w+a+n+k+(?:s|ed|ing|er|ers)?$/,
  /^p+o+o+(?:s|ed|ing|py)?$/,
  /^p+o+o+p+(?:s|ed|ing|y)?$/,
  /^c+u+m+(?:s|med|ming|shot|shots)?$/,
  /^j+i+z+z+(?:ed|ing)?$/,
  /^p+i+s+s+(?:es|ed|ing)?$/,
  /^f+a+r+t+(?:s|ed|ing)?$/,
  /^d+i+c+k+(?:s|head|heads)?$/,
  /^c+o+c+k+(?:s|head|heads)?$/,
  /^b+o+o+b+(?:s|ie|ies)?$/,
  /^t+i+t+(?:s|ty|ties)?$/,
  /^p+o+r+n+(?:o|ography|hub)?$/,
  /^h+e+n+t+a+i+$/
];

const LEET_MAP = { '0':'o','1':'i','2':'z','3':'e','4':'a','5':'s','6':'g','7':'t','8':'b','9':'g','@':'a','$':'s','!':'i','+':'t','€':'e','£':'l' };
function normaliseClassroomText(value) {
  let s = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  s = [...s].map(ch => LEET_MAP[ch] || ch).join('');
  // Collapse excessive repeats but leave doubles intact: fuuuuuck -> fuuck,
  // then the pattern family above still catches it.
  s = s.replace(/([a-z])\1{3,}/g, '$1$1');
  return s.replace(/[^a-z0-9]+/g,' ').trim();
}
function tokenBlocked(token) {
  if (!token) return false;
  if (CLASSROOM_BLOCKED_WORDS.has(token)) return true;
  return CLASSROOM_BLOCKED_TOKEN_PATTERNS.some(re => re.test(token));
}
function blockedClassroomWord(value) {
  const normal = normaliseClassroomText(value);
  if (!normal) return '';
  const tokens = normal.split(/\s+/).filter(Boolean);
  for (const token of tokens) if (tokenBlocked(token)) return token;

  // Catch punctuation/spaces inserted into a blocked term: c.u.m, p o o,
  // f-u-c-k, etc. Limit the join window to avoid accidental phrase matches.
  for (let start = 0; start < tokens.length; start++) {
    let compact = '';
    for (let i = start; i < Math.min(tokens.length, start + 10); i++) {
      compact += tokens[i];
      if (tokenBlocked(compact)) return compact;
      if (compact.length > 28) break;
    }
  }
  return '';
}
function classroomSafeOrError(res, value, label='That wording') {
  if (!blockedClassroomWord(value)) return true;
  json(res, 400, { error: `${label} is blocked by the classroom language filter. Try different wording.` });
  return false;
}

const slide = (question) => ({ question });

// Each presentation is a deliberately written three-beat mini story. The image
// changes, but the question for that beat does not. This keeps the headline,
// follow-up and visual challenge pointing in the same direction.
const presentationPacks = {
  games: [
    { id:'g-horror', title:'Pitch the perfect horror game', slides:[
      slide('This is where the player wakes up. What happened here, and what are they trying to escape?', ['abandoned hospital corridor photograph','dark abandoned staircase photograph']),
      slide('This is now the thing hunting the player. What makes it terrifying, and how does the player survive it?', ['wolf close up photograph','creepy mannequin photograph']),
      slide('This is the final reveal. Explain what it means and why players will still be talking about it afterwards.', ['locked door dark photograph','abandoned room dramatic photograph'])
    ]},
    { id:'g-openworld', title:'My £100 million open-world game', slides:[
      slide('This is the main region of the map. What can the player actually do here that justifies an open world?', ['mountain valley aerial photograph','large city aerial photograph']),
      slide('This becomes the main way players travel around the world. How does it work without becoming annoying?', ['motorcycle road photograph','off road vehicle photograph']),
      slide('This is the image used to sell the entire game. What promise does it make to the player?', ['dramatic landscape sunset photograph','city skyline night photograph'])
    ]},
    { id:'g-boss', title:'Design the perfect final boss', slides:[
      slide('This is the boss. Who or what are they, and why has the whole game been building towards this fight?', ['large animal close up photograph','armoured costume portrait photograph']),
      slide('This is the boss\'s ridiculous weakness. How does the player discover it and use it in the fight?', ['glowing object photograph','large red button photograph']),
      slide('This is the arena for the final phase. What changes here that makes the ending feel huge?', ['castle courtyard photograph','industrial factory interior photograph'])
    ]},
    { id:'g-coop', title:'Pitch the next huge co-op game', slides:[
      slide('This is the job the players have to complete together. Why does it need cooperation instead of four people doing their own thing?', ['rescue boat team photograph','construction team photograph']),
      slide('Every player must interact with this somehow. What terrible arguments will it cause between friends?', ['control panel buttons photograph','rope pulley photograph']),
      slide('This is what the team gets if everyone survives. Why will people immediately want to play another round?', ['trophy photograph','treasure chest photograph'])
    ]},
    { id:'g-indie', title:'The greatest indie game nobody has made yet', slides:[
      slide('Your entire game starts with this one image. What is the simple idea that makes it interesting?', ['small workshop photograph','single object on table photograph']),
      slide('You only have one developer and six months, but this feature absolutely has to stay. How do you keep the scope under control?', ['laptop programming photograph','small game jam team photograph']),
      slide('This is the Steam page hero image. Give us the ten-second pitch that makes people click Buy.', ['neon city night photograph','dramatic forest photograph'])
    ]},
    { id:'g-esport', title:'Turn this into the next big esport', slides:[
      slide('This is the core skill players compete over. What separates a beginner from a professional?', ['game controller hands photograph','arcade joystick photograph']),
      slide('This is suddenly part of the tournament rules. Explain how it creates strategy rather than pure nonsense.', ['large screen arena photograph','timer clock photograph']),
      slide('This is the championship trophy. Why would thousands of people watch someone win it?', ['sports trophy photograph','esports crowd photograph'])
    ]},
    { id:'g-rpg', title:'Why every RPG needs this', slides:[
      slide('This becomes an important item or character in the opening hour. Why should the player care about it?', ['medieval object photograph','fantasy costume portrait photograph']),
      slide('Twenty hours later it turns out to be central to the main quest. What was the player missing all along?', ['ancient key photograph','old book photograph']),
      slide('This is the reward at the end of the questline. Was the whole ridiculous journey actually worth it?', ['gold crown photograph','ornate sword photograph'])
    ]},
    { id:'g-dlc', title:'Pitch the worst DLC idea that would still sell millions', slides:[
      slide('This is the headline feature of the DLC. Why would anyone pay extra for it?', ['video game controller photograph','theme park attraction photograph']),
      slide('The publisher now wants this monetised as well. Explain the completely reasonable business model.', ['vending machine photograph','coin slot photograph']),
      slide('This is the collector\'s edition bonus. Give us the shameless final sales pitch.', ['collectors box photograph','trophy photograph'])
    ]},
    { id:'g-tutorial', title:'Design a tutorial players will not skip', slides:[
      slide('This is the first thing the player has to learn. How do you teach it without putting text all over the screen?', ['game controller hands photograph','door handle photograph']),
      slide('The player keeps failing here. How does the game teach them what they are doing wrong without just shouting instructions?', ['obstacle course photograph','warning sign photograph']),
      slide('This is the final tutorial challenge. How does it prove the player is ready for the real game?', ['training arena photograph','large staircase photograph'])
    ]},
    { id:'g-franchise', title:'Save a dying game franchise', slides:[
      slide('This represents what made the original games special. What absolutely must the reboot keep?', ['retro arcade machine photograph','vintage game controller photograph']),
      slide('The publisher insists this modern trend is added. How do you stop it ruining the game?', ['smartphone photograph','esports stage photograph']),
      slide('This is the first screenshot of the reboot shown to the public. Convince angry fans you have not destroyed their childhood.', ['dramatic castle photograph','neon city photograph'])
    ]},
    { id:'g-mechanic', title:'Invent a terrible game mechanic that somehow becomes brilliant', slides:[
      slide('This object is the mechanic. What does the player actually do with it every few minutes?', ['mechanical lever photograph','large button photograph']),
      slide('Now the whole progression system depends on it. How does getting better at this ridiculous mechanic work?', ['control panel photograph','toolbox photograph']),
      slide('This is the moment reviewers finally understand why the mechanic is genius. What happens?', ['crowd cheering photograph','dramatic stage photograph'])
    ]},
    { id:'g-fasttravel', title:'Fix fast travel in open-world games', slides:[
      slide('This becomes the player\'s main way of getting around. What makes the journey itself worth playing?', ['train landscape photograph','motorcycle road photograph']),
      slide('This rule stops players spamming fast travel. How does it create interesting decisions rather than wasting time?', ['road barrier photograph','fuel gauge photograph']),
      slide('This is the place players keep choosing to return to. Why does your travel system make the world feel more connected?', ['town square photograph','train station photograph'])
    ]},
    { id:'g-controller', title:'Design a game where the controller fights back', slides:[
      slide('The controller now does something completely unhelpful every few minutes. What does it do, and why is that somehow part of the game?'),
      slide('Players discover a ridiculous trick that turns the annoying controller behaviour into an advantage. What is it?'),
      slide('This becomes the final challenge built entirely around the controller betraying you. How do players beat it?')
    ]},
    { id:'g-npc', title:'Make the most useless NPC in gaming absolutely essential', slides:[
      slide('This is the NPC everyone immediately hates. What do they do that makes them so spectacularly useless?'),
      slide('Halfway through the game we discover this NPC has one bizarre skill nobody else has. Why does the player suddenly need them?'),
      slide('This NPC now has to save the world. Explain the heroic moment nobody saw coming.')
    ]},
    { id:'g-speedrun', title:'Design a game speedrunners will completely destroy', slides:[
      slide('This is the mechanic you thought would take players hours to master. How are speedrunners already abusing it?'),
      slide('Someone discovers this ridiculous shortcut. Why does it skip half the game without technically cheating?'),
      slide('The world record now depends on doing this absurd thing perfectly. Talk us through the run.')
    ]},
    { id:'g-micro', title:'Invent a microtransaction nobody could possibly defend', slides:[
      slide('This completely normal game feature now costs extra. Explain the publisher\'s shameless sales pitch.'),
      slide('Players find an even more ridiculous thing hidden behind a premium tier. What is it?'),
      slide('Against all logic, people actually start buying it. Why does it become embarrassingly popular?')
    ]},
    { id:'g-physics', title:'Build a brilliant game around absolutely terrible physics', slides:[
      slide('This basic object refuses to behave properly. What does it do every time the player touches it?'),
      slide('Players realise the broken physics can be used as a core mechanic. How does that work?'),
      slide('The final level expects the player to deliberately break the physics as hard as possible. What is the challenge?')
    ]},
    { id:'g-stealth', title:'Make a stealth game for someone who is terrible at stealth', slides:[
      slide('The player has already blown their cover. What ridiculous system lets them pretend everything is still fine?'),
      slide('This is somehow the best hiding place in the entire game. Explain why nobody notices you.'),
      slide('The final mission goes completely wrong in the first ten seconds. How can the player still somehow complete it stealthily?')
    ]},
    { id:'g-escort', title:'Finally fix the dreaded escort mission', slides:[
      slide('This is the person or thing you have to escort. What makes protecting them instantly annoying?'),
      slide('You are allowed to add one ridiculous feature to stop the escort target getting themselves killed. What is it?'),
      slide('The escort target unexpectedly becomes the most powerful thing in the level. What happens?')
    ]},
    { id:'g-loading', title:'Make loading screens the best part of the game', slides:[
      slide('Players are now genuinely excited to see a loading screen. What happens during it?'),
      slide('This loading-screen feature starts affecting the actual game. How does it work?'),
      slide('The final loading screen becomes an important part of the ending. What does the player have to do?')
    ]}
  ],
  film: [
    { id:'f-horror', title:'Pitch the perfect horror film', slides:[
      slide('This is the opening location. What happened here, and what tells the audience they should already be worried?', ['abandoned house interior photograph','dark corridor photograph']),
      slide('This is the thing we finally see halfway through the film. Why is it worse than what the audience imagined?', ['creepy mannequin photograph','masked person photograph']),
      slide('This is the final shot before the credits. What does it reveal that changes the whole film?', ['locked door dark photograph','empty room dramatic photograph'])
    ]},
    { id:'f-blockbuster', title:'My £100 million blockbuster pitch', slides:[
      slide('This is the huge set piece from the trailer. What is happening and why can audiences not miss it?', ['city explosion aftermath photograph','large crowd event photograph']),
      slide('The studio insists this character or object must now be central to the story. Make it feel intentional.', ['robot costume photograph','mysterious suitcase photograph']),
      slide('This is the poster image. Give us the final one-sentence pitch that gets people into cinemas.', ['dramatic skyline sunset photograph','cinema marquee photograph'])
    ]},
    { id:'f-franchise', title:'Save a failing film franchise', slides:[
      slide('This represents the one thing fans still love about the franchise. What do you keep?', ['old cinema photograph','iconic costume photograph']),
      slide('The studio demands this trend is added to attract a new audience. How do you stop it feeling desperate?', ['smartphone social media photograph','green screen studio photograph']),
      slide('This is the first image released from the reboot. Convince angry fans the franchise is safe in your hands.', ['dramatic castle photograph','city night photograph'])
    ]},
    { id:'f-streaming', title:'Pitch the next huge streaming series', slides:[
      slide('This is the image everyone sees in the thumbnail. What is the show actually about?', ['mysterious person portrait photograph','dramatic house photograph']),
      slide('Episode four reveals this and suddenly everyone online is arguing about it. What happened?', ['locked box photograph','masked person photograph']),
      slide('This is the cliffhanger at the end of season one. What makes people immediately demand another series?', ['open door dark photograph','dramatic city night photograph'])
    ]},
    { id:'f-villain', title:'Create the perfect villain reveal', slides:[
      slide('Before we properly meet the villain, this is the first clue they exist. What does it tell us?', ['mysterious letter photograph','shadow silhouette photograph']),
      slide('This is the villain when they finally appear. Why are they instantly memorable?', ['masked portrait photograph','formal portrait dramatic photograph']),
      slide('This is the villain\'s final moment. Do they lose, escape or somehow win?', ['empty throne photograph','burning building photograph'])
    ]},
    { id:'f-action', title:'The one thing every action film needs', slides:[
      slide('This is your first action sequence. What makes it exciting rather than just noisy?', ['motorcycle chase photograph','helicopter photograph']),
      slide('Halfway through the film this becomes the hero\'s only option. How do they use it to survive?', ['construction vehicle photograph','rope bridge photograph']),
      slide('This is the ridiculous final stunt. Talk us through exactly what happens.', ['aircraft runway photograph','high bridge photograph'])
    ]},
    { id:'f-oscar', title:'My completely serious plan to win an Oscar', slides:[
      slide('This is the character or situation the audience must immediately care about. What is their struggle?', ['elderly person portrait photograph','lonely train station photograph']),
      slide('This becomes the emotional scene used in every awards clip. Why is everyone crying?', ['rain window portrait photograph','empty chair photograph']),
      slide('This is the final image of the film. Explain why critics will call it profound.', ['sunset silhouette photograph','empty road sunset photograph'])
    ]},
    { id:'f-documentary', title:'Pitch an award-winning documentary nobody asked for', slides:[
      slide('This is the subject of your documentary. Why is there secretly an amazing story here?', ['old shop owner portrait photograph','small factory photograph']),
      slide('Your investigation uncovers this. Why does it completely change what we thought the documentary was about?', ['archive box photograph','old newspaper photograph']),
      slide('This is the final image before the credits. What question do you want the audience to leave thinking about?', ['empty street evening photograph','single chair photograph'])
    ]},
    { id:'f-prop', title:'The one prop that can carry an entire film', slides:[
      slide('This is the prop. Why does every important character want it?', ['old key photograph','mysterious suitcase photograph']),
      slide('Halfway through the film we discover the prop can do this. What changes?', ['mechanical device photograph','glowing lamp photograph']),
      slide('This is what happens to the prop in the final scene. Why is that the perfect ending?', ['object on fire photograph','object underwater photograph'])
    ]},
    { id:'f-sequel', title:'Pitch the worst sequel idea that might actually work', slides:[
      slide('The sequel starts here. How do you justify dragging the story back for another film?', ['small town street photograph','airport arrivals photograph']),
      slide('This is the returning character nobody expected. Why are they suddenly important again?', ['dramatic older person portrait photograph','masked figure photograph']),
      slide('This is the final reveal that sets up film number three. How much worse can this franchise get?', ['locked vault photograph','spaceship photograph'])
    ]},
    { id:'f-cheap', title:'Make a blockbuster with basically no budget', slides:[
      slide('This is your main location because it is all you can afford. How do you make the whole film work here?', ['empty office room photograph','small apartment interior photograph']),
      slide('This household object now has to become your biggest special effect. What does the audience see?', ['desk lamp photograph','electric fan photograph']),
      slide('This is the one expensive-looking shot you save for the trailer. How did you fake it?', ['city skyline night photograph','dramatic smoke photograph'])
    ]},
    { id:'f-opening', title:'Design the perfect opening scene', slides:[
      slide('This is the very first shot. What does it tell us before anyone says a word?', ['empty street dawn photograph','close up object photograph']),
      slide('Thirty seconds later this appears. What question does it plant in the audience\'s head?', ['mysterious suitcase photograph','masked person photograph']),
      slide('This is the final image before the title appears. Why are we now completely hooked?', ['open door dark photograph','dramatic skyline photograph'])
    ]},
    { id:'f-worsthero', title:'Pitch a blockbuster with the worst possible hero', slides:[
      slide('This is our hero. What makes them completely unsuitable for the mission they have just been given?'),
      slide('Their worst personality trait unexpectedly saves everyone. How?'),
      slide('This is their big heroic moment at the end. Why is the audience somehow cheering for them now?')
    ]},
    { id:'f-remake', title:'Remake a classic film for absolutely no reason', slides:[
      slide('This is the one completely unnecessary change you make to the original. How do you justify it?'),
      slide('The studio insists this new character must be added. Who are they and why are they suddenly central to the plot?'),
      slide('This is the scene from the remake that causes the internet to lose its mind. What did you do?')
    ]},
    { id:'f-product', title:'Make shameless product placement essential to the plot', slides:[
      slide('This product has to appear constantly. Why does the hero apparently need it to survive?'),
      slide('The product now becomes important during the most emotional scene in the film. Explain how.'),
      slide('The final battle cannot be won without the product. Give us the least subtle payoff imaginable.')
    ]},
    { id:'f-monsterfail', title:'Create a terrifying movie monster with one embarrassing problem', slides:[
      slide('This is the monster. What makes it genuinely frightening when we first see it?'),
      slide('We discover the monster has this ridiculous problem. Why does it completely ruin its intimidation factor?'),
      slide('The monster somehow turns that weakness into its most dangerous ability. What happens?')
    ]},
    { id:'f-romcom', title:'Pitch the worst romantic meet-cute ever filmed', slides:[
      slide('This is how the two leads first meet. Why should this absolutely not result in romance?'),
      slide('This terrible misunderstanding somehow brings them closer together. What happened?'),
      slide('This is the grand romantic gesture at the end. Explain why it works despite being objectively awful.')
    ]},
    { id:'f-trailer', title:'Make a trailer that spoils the entire film but still sells it', slides:[
      slide('The trailer accidentally reveals this huge plot point in the first ten seconds. How do you recover?'),
      slide('The marketing team now insists on showing the biggest twist as well. Why might audiences still want to watch?'),
      slide('This is the final shot of the trailer. Somehow it gives away the ending and creates even more hype. Explain.')
    ]},
    { id:'f-extra', title:'Make a background extra more interesting than the main character', slides:[
      slide('This background character is doing something nobody can stop watching. What are they doing?'),
      slide('Viewers realise the extra has secretly appeared in every major scene. What is really going on?'),
      slide('By the ending, the extra has accidentally become the hero. How?')
    ]},
    { id:'f-ending', title:'Explain the film ending everyone pretends to understand', slides:[
      slide('This happens five minutes before the end and nobody knows what it means. Explain it with complete confidence.'),
      slide('This final object, person or event is apparently symbolic. Symbolic of what exactly?'),
      slide('The credits roll immediately after this. Give us the explanation critics will argue about for the next ten years.')
    ]}
  ],
  esports: [
    { id:'e-team', title:'Build the perfect esports team', slides:[
      slide('This is your star player. What role do they play, and why does the whole team revolve around them?', ['focused gamer at desk photograph','esports player portrait photograph']),
      slide('This is the team strategy nobody else can stop. How does it work?', ['tactical whiteboard photograph','team huddle photograph']),
      slide('This is the moment your team wins the grand final. Describe the play and the reaction.', ['esports arena crowd photograph','team celebrating trophy photograph'])
    ]},
    { id:'e-title', title:'Pitch the next big esports title', slides:[
      slide('This is the core of the game. Why would players and viewers become obsessed with it?', ['competitive gaming setup photograph','intense keyboard and mouse photograph']),
      slide('This is the feature that makes the game impossible to cast normally. How do broadcasts handle it?', ['broadcast desk photograph','multiple monitor control room photograph']),
      slide('This is the image used to sell the first world championship. Why does it make the game look huge?', ['packed arena lights photograph','dramatic stage spotlight photograph'])
    ]},
    { id:'e-grandfinal', title:'Design the most stressful grand final ever', slides:[
      slide('This is the setting for the final. Why does it instantly feel massive?', ['esports stage photograph','stadium crowd photograph']),
      slide('This is the ridiculous thing that goes wrong mid-match. How does it change the pressure?', ['power cable photograph','blank computer monitor photograph']),
      slide('This is the final clutch moment. Talk us through what everyone watching is screaming about.', ['player reaction close up photograph','crowd celebrating photograph'])
    ]},
    { id:'e-patch', title:'Explain the worst patch note that somehow improves the game', slides:[
      slide('This is the change the developers have just announced. What has everyone lost their mind over?', ['game update screen photograph','developer livestream setup photograph']),
      slide('This is the bizarre meta that appears because of the patch. Why is it so stupid but effective?', ['notebook strategy sketch photograph','gaming mouse photograph']),
      slide('This is the tournament match that proves the patch secretly made the game better. What happens?', ['player at tournament desk photograph','esports audience photograph'])
    ]},
    { id:'e-sponsor', title:'Make a ridiculous sponsor work for a serious team', slides:[
      slide('This is your new sponsor. Why has the organisation accepted the deal?', ['sponsor backdrop photograph','team jersey photograph']),
      slide('This is the branding disaster the team now has to lean into. How do they spin it?', ['team photo shoot photograph','press conference microphone photograph']),
      slide('This is the campaign that somehow turns the sponsor into a fan favourite. Why does it work?', ['crowd selfie photograph','team celebrating on stage photograph'])
    ]},
    { id:'e-coach', title:'Save a failing esports team', slides:[
      slide('This is the team at its lowest point. What exactly is going wrong?', ['sad gamer at desk photograph','empty practice room photograph']),
      slide('This is the one brutal change you make as coach. Why does it upset everyone at first?', ['coach talking to team photograph','strategy board photograph']),
      slide('This is the first result that proves your rebuild is working. What finally clicks?', ['team high five photograph','stage handshake photograph'])
    ]},
    { id:'e-walkon', title:'Design the most ridiculous esports team walk-on', slides:[
      slide('This is how the team enters the arena. Why did anyone approve this?'),
      slide('The walk-on goes wrong in a spectacular way. What happens just before the match starts?'),
      slide('The team wins anyway and now fans demand the walk-on becomes tradition. What does it turn into?')
    ]},
    { id:'e-sub', title:'Your emergency substitute is the worst possible choice', slides:[
      slide('Your star player cannot play, so this person is somehow the emergency substitute. Why are they wildly unqualified?'),
      slide('They reveal one bizarre skill that suddenly makes the substitution look genius. What is it?'),
      slide('The final round now depends entirely on them. Talk us through the unbelievable clutch.')
    ]},
    { id:'e-hardware', title:'Make completely ridiculous hardware tournament legal', slides:[
      slide('A player turns up using this as their controller or setup. How is it even supposed to work?'),
      slide('Officials discover it gives them a very strange competitive advantage. What advantage?'),
      slide('By the grand final everyone has copied it. What has professional esports become?')
    ]},
    { id:'e-meta', title:'Invent the winning strategy absolutely everyone hates', slides:[
      slide('This strategy looks stupid but keeps winning. What are players actually doing?'),
      slide('The opposing team tries this desperate counter-strategy. Why does it make everything even worse?'),
      slide('The strategy wins a championship and gets patched the next morning. What was the final play?')
    ]},
    { id:'e-caster', title:'Give the caster the hardest moment of their career', slides:[
      slide('Something completely bizarre happens during the match. How does the caster explain it live without losing it?'),
      slide('The replay somehow makes the situation even more confusing. What did everyone miss the first time?'),
      slide('This becomes the caster\'s most famous call. Give us the line they shout at the final moment.')
    ]},
    { id:'e-trophy', title:'Design the worst esports trophy anyone has ever seen', slides:[
      slide('This is the championship trophy. Why does it look completely wrong for a major event?'),
      slide('The organisers reveal an even stranger feature built into the trophy. What does it do?'),
      slide('The winning team somehow makes it iconic. What do they do with it on stage?')
    ]},
    { id:'e-techpause', title:'Turn a technical pause into the biggest moment of the tournament', slides:[
      slide('The match suddenly stops for a technical problem. What has gone wrong?'),
      slide('While everyone waits, this completely unplanned thing starts happening in the arena. Why does the crowd love it?'),
      slide('Play finally resumes and the technical problem somehow affects the decisive moment. What happens?')
    ]},
    { id:'e-rivalry', title:'Create the pettiest esports rivalry imaginable', slides:[
      slide('These two teams now hate each other for an unbelievably minor reason. What started it?'),
      slide('The rivalry escalates because of this ridiculous incident before the match. What happened?'),
      slide('They finally meet in the grand final. What petty final gesture makes the rivalry legendary?')
    ]}
  ],
  sports: [
    { id:'s-underdog', title:'Build the perfect underdog sports team', slides:[
      slide('This is the first key player you build around. What makes them unlikely but perfect for the story?', ['amateur footballer portrait photograph','runner portrait photograph']),
      slide('This is the obstacle that should end the dream run. How does the team somehow get through it?', ['rainy training field photograph','injured athlete bench photograph']),
      slide('This is the moment the underdogs shock everyone. Talk us through it like a pundit.', ['crowd celebrating goal photograph','athletes celebrating victory photograph'])
    ]},
    { id:'s-cupfinal', title:'Design the most dramatic cup final ever', slides:[
      slide('This is the setting for the final. Why does it instantly feel huge?', ['football stadium crowd photograph','night stadium lights photograph']),
      slide('This is the bizarre turning point that flips the whole match. What happens?', ['referee whistle photograph','ball on goal line photograph']),
      slide('This is the winning moment. Give us the commentary everyone remembers forever.', ['last minute goal celebration photograph','trophy celebration crowd photograph'])
    ]},
    { id:'s-manager', title:'Explain the chaos of a new manager taking over', slides:[
      slide('This is the new manager. Why is their appointment exciting, risky or completely absurd?', ['coach portrait photograph','manager at press conference photograph']),
      slide('This is the first huge change they make. Why does it split the fans immediately?', ['training session photograph','tactics board photograph']),
      slide('This is the result that finally makes people believe in the project. What changes?', ['team celebrating with manager photograph','fans in stadium photograph'])
    ]},
    { id:'s-training', title:'Invent the training method that changes sport forever', slides:[
      slide('This is the core training idea. What does it improve that everyone else has ignored?', ['athlete training drill photograph','gym session photograph']),
      slide('This is the part of the method that looks ridiculous from the outside. Why does it still work?', ['balance exercise photograph','recovery pool photograph']),
      slide('This is the first competition where the benefits are obvious. What do commentators notice?', ['athlete crossing finish line photograph','team intense match photograph'])
    ]},
    { id:'s-mascot', title:'Create the most terrifying team mascot imaginable', slides:[
      slide('This is your mascot. Why did the club think this was a good idea?', ['sports mascot costume photograph','team launch event photograph']),
      slide('This is the stunt the mascot pulls that becomes an accidental legend. What happens?', ['mascot on pitch photograph','crowd reaction photograph']),
      slide('This is the image that ends up on every bit of club merchandise. Why do fans weirdly love it?', ['fans with scarves photograph','club shop display photograph'])
    ]},
    { id:'s-documentary', title:'Pitch the sports documentary everyone suddenly binges', slides:[
      slide('This is the team, athlete or season your documentary follows. Why is there a bigger story here?', ['locker room photograph','athlete portrait documentary photograph']),
      slide('This is the revelation halfway through the series that hooks the audience. What changes?', ['archive footage photograph','newspaper desk photograph']),
      slide('This is the final image before the credits. Why does it leave people desperate for season two?', ['empty stadium at dusk photograph','athlete walking tunnel photograph'])
    ]},
    { id:'s-newrule', title:'Add one ridiculous new rule to a sport', slides:[
      slide('This is the new rule. Why would any governing body think the sport needed it?'),
      slide('Teams discover a ridiculous loophole in the rule almost immediately. How do they exploit it?'),
      slide('The rule decides a major final in the strangest way possible. What happens?')
    ]},
    { id:'s-celebration', title:'Design the most over-the-top goal celebration ever', slides:[
      slide('This is the first part of the celebration. Why does it already feel far too elaborate?'),
      slide('The rest of the team suddenly joins in with this. How much planning has clearly gone into it?'),
      slide('The celebration goes wrong but somehow becomes even more iconic. What happens?')
    ]},
    { id:'s-transfer', title:'Make the worst transfer signing become a club legend', slides:[
      slide('This is the new signing. Why are supporters immediately convinced the club has made a terrible mistake?'),
      slide('They reveal one completely unexpected ability that changes everything. What is it?'),
      slide('This is the moment they become a club legend. Talk us through what happens.')
    ]},
    { id:'s-reftech', title:'Give the referee a new gadget that causes total chaos', slides:[
      slide('This is the referee\'s new piece of technology. What is it supposed to improve?'),
      slide('The gadget starts causing a ridiculous problem during the match. What is going wrong?'),
      slide('The final decision now depends entirely on the gadget. Explain the most controversial outcome possible.')
    ]},
    { id:'s-kit', title:'Design the worst team kit that somehow becomes iconic', slides:[
      slide('This is the new kit. Why are the fans absolutely horrified when it is revealed?'),
      slide('The team starts winning every time they wear it. What ridiculous superstition develops?'),
      slide('Years later this awful kit is treated as a classic. Why does everyone suddenly want one?')
    ]},
    { id:'s-stadium', title:'Add one completely unnecessary feature to a stadium', slides:[
      slide('This is the stadium\'s new feature. Who thought spectators needed this?'),
      slide('The feature unexpectedly starts affecting the actual match. How?'),
      slide('It becomes the stadium\'s most famous tradition. What happens every time the home team wins?')
    ]},
    { id:'s-pundit', title:'Make the worst pundit prediction somehow come true', slides:[
      slide('A pundit confidently makes this ridiculous prediction before the match. What do they claim will happen?'),
      slide('Halfway through, the impossible prediction starts looking strangely realistic. What changed?'),
      slide('The prediction comes true in the final seconds. Give us the pundit\'s unbearably smug reaction.')
    ]},
    { id:'s-penalties', title:'Reinvent the penalty shootout', slides:[
      slide('Normal penalties are gone. What ridiculous new challenge decides a tied match instead?'),
      slide('Teams discover a strange specialist is now incredibly valuable. What are they good at?'),
      slide('The championship is decided by the final attempt. Talk us through the most dramatic version of your new shootout.')
    ]}
  ]

};

const actionPrompts = {
  games: [
    'Answer like a smug developer pretending this was always intentional.',
    'Answer like an NPC who has repeated this same line for 400 hours.',
    'Answer like a speedrunner who is far too excited about a glitch.',
    'Answer like a terrified player who has just seen this for the first time.',
    'Answer in your best dramatic tutorial voice.',
    'Answer like an angry reviewer trying not to rage quit.',
    'Answer like a final boss delivering a speech.',
    'Answer like a streamer trying to hype up terrible gameplay.',
    'Answer like a designer defending a very bad mechanic.',
    'Answer like the game is being advertised in a cheesy trailer.'
  ],
  film: [
    'Answer like a wildly overdramatic movie trailer narrator.',
    'Answer like an actor giving the most intense audition imaginable.',
    'Answer like a furious director who has had enough of this cast.',
    'Answer like an Oscar winner accepting a very emotional award.',
    'Answer like a documentary narrator taking this far too seriously.',
    'Answer like a background extra who thinks they are the real star.',
    'Answer like a horror victim trying to keep calm.',
    'Answer like a film critic who absolutely hates the script.',
    'Answer like a studio executive pretending this was a brilliant idea.',
    'Answer like the villain giving their big monologue.'
  ],
  esports: [
    'Answer like an overexcited caster losing their mind on broadcast.',
    'Answer like a tilted pro who cannot believe what just happened.',
    'Answer like a coach in a desperate timeout speech.',
    'Answer like a winner in a painfully awkward post-match interview.',
    'Answer like an analyst trying to justify a terrible strategy.',
    'Answer like a streamer farming clips from absolute chaos.',
    'Answer like a player doing the biggest pop-off of their life.',
    'Answer like the losing team trying to explain the throw.',
    'Answer like the desk host building fake drama.',
    'Answer like a very smug champion after the final.'
  ],
  sports: [
    'Answer like a furious football manager in a post-match interview.',
    'Answer like an excitable commentator calling the biggest moment ever.',
    'Answer like a biased pundit who refuses to admit they were wrong.',
    'Answer like a referee awkwardly explaining the decision.',
    'Answer like a player giving the most boring interview in history.',
    'Answer like a club legend pretending this used to happen every week.',
    'Answer like a crowd-hyping stadium announcer.',
    'Answer like a touchline coach who has completely lost their voice.',
    'Answer like a newspaper columnist making this sound historic.',
    'Answer like a goalkeeper who has become far too confident.'
  ]
};
function stableNumber(text) {
  let h=2166136261;
  for (const ch of String(text||'')) { h ^= ch.charCodeAt(0); h = Math.imul(h,16777619); }
  return h >>> 0;
}
function actionSuggestions(room) {
  const pool=actionPrompts[room.subject] || actionPrompts.games;
  const target=producerTargetSlideNumber(room);
  const start=stableNumber(`${room.round.roundId}:${room.round.packId}:${target}`) % pool.length;
  const result=[];
  for(let i=0;i<4;i++) result.push(pool[(start+i*3)%pool.length]);
  return [...new Set(result)].slice(0,4);
}

function performanceVoteTarget(room) {
  const eligible = Math.max(0, room.players.size - (room.round.presenterId ? 1 : 0));
  if (eligible <= 1) return 1;
  return Math.max(2, Math.ceil(eligible / 2));
}
function settlePerformanceBonus(room) {
  const r = room.round;
  if (!r?.revealed?.performance) { r.performanceVotes = {}; return; }
  const count = Object.keys(r.performanceVotes || {}).length;
  const target = performanceVoteTarget(room);
  if (count >= target && !r.revealed.performanceAwarded) {
    r.revealed.performanceAwarded = true;
    r.performanceBonus = Math.min(1, Number(r.performanceBonus || 0) + 0.5);
  }
  r.performanceVotes = {};
}

function getPack(subject, id) {
  const pool = presentationPacks[subject] || presentationPacks.games;
  return pool.find(p => p.id === id) || pool[0];
}
function pickPresentationPack(room) {
  const pool = presentationPacks[room.subject] || presentationPacks.games;
  let options = pool.filter(p => !room.usedTopics.has(p.id));
  if (!options.length) { room.usedTopics.clear(); options = [...pool]; }
  const selected = pick(options);
  room.usedTopics.add(selected.id);
  return selected;
}
function wrapUpSlide(pack, subject) {
  const subjectWrap = {
    games:'WRAP-UP: In 20 seconds, tie the final surprise back to your idea and convince us to play the game.',
    film:'WRAP-UP: In 20 seconds, tie the final surprise back to the story and convince us to watch the film.',
    esports:'WRAP-UP: Give us the headline and a 20-second final pitch for why people care about what just happened.',
    sports:'WRAP-UP: Give us tomorrow’s headline and a 20-second pundit wrap-up that makes the whole story sound legendary.'
  };
  return { question: subjectWrap[subject] || subjectWrap.games };
}
function packSlide(pack, slideNumber, subject='games') {
  const n = Number(slideNumber) || 1;
  if (n >= 4) return wrapUpSlide(pack, subject);
  return pack.slides[Math.max(0, Math.min(2, n - 1))];
}
function stageLabel(slideNumber) {
  return ['THE SETUP','THE TWIST','THE PAYOFF','THE WRAP-UP'][Math.max(0, Math.min(3, (Number(slideNumber) || 1) - 1))];
}

function imageEngineStatus(room) { return room?.allowActions === false ? 'Write + draw' : 'Write + draw + performance bonus'; }

function randomId(len = 16) { return crypto.randomBytes(len).toString('hex'); }
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffled(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}



function producerTargetSlideNumber(room) {
  const r=room.round;
  if (r.phase === 'intro') return 1;
  if (r.phase === 'presenting' && r.slideNumber < 4) return r.slideNumber + 1;
  return Math.max(1, Number(r.slideNumber || 1));
}
function producerSlideData(room) {
  return packSlide(getPack(room.subject, room.round.packId), producerTargetSlideNumber(room), room.subject);
}
function textChoice(text,prompt) {
  const clean=String(text||'').trim().replace(/\s+/g,' ').slice(0,180);
  return { id:randomId(6), kind:'text', text:clean, title:clean, prompt, flavour:'TEXT', provider:'Producer text' };
}
function drawingChoice(dataUrl,prompt) {
  return { id:randomId(6), kind:'drawing', url:dataUrl, title:'Producer drawing', prompt, flavour:'DRAWING', provider:'Producer drawing', fallback:'teacher-cat.svg' };
}
function actionChoice(text,prompt) {
  const clean=String(text||'').trim().replace(/\s+/g,' ').slice(0,180);
  return { id:randomId(6), kind:'performance', text:clean, title:clean, prompt, flavour:'PERFORMANCE', provider:'Producer performance challenge' };
}

function emptyRound() {
  return {
    phase: 'lobby', presenter: '', presenterId: '', producerId: '', producerName: '', topic: '', packId: '',
    slideNumber: 0, pendingChoice: null, pendingPerformance: null, revealed: null, introStartedAt: 0,
    votes: {}, result: null, reactions: [], roundId: randomId(5), performanceVotes: {}, performanceBonus: 0
  };
}
function cleanRoom(room) {
  const now = Date.now();
  for (const [id, p] of room.players) if (now - p.lastSeen > 1000 * 60 * 30) room.players.delete(id);
  syncTurnOrder(room);
  if (room.round.producerId && !room.players.has(room.round.producerId)) {
    room.round.producerId = '';
    room.round.producerName = '';
  }
  if (room.round.presenterId && !room.players.has(room.round.presenterId)) {
    room.round.presenterId = '';
  }
}
function playerList(room) {
  return [...room.players.entries()].map(([id,p]) => ({ id, name: p.name }));
}
function syncTurnOrder(room) {
  room.turnOrder ||= [];
  room.turnOrder = room.turnOrder.filter(id => room.players.has(id));
  for (const id of room.players.keys()) if (!room.turnOrder.includes(id)) room.turnOrder.push(id);
  if (!room.turnOrder.length) room.turnCursor = 0;
  else if (room.turnCursor >= room.turnOrder.length) room.turnCursor = room.turnCursor % room.turnOrder.length;
}
function suggestedPair(room) {
  syncTurnOrder(room);
  const ids = room.turnOrder || [];
  if (!ids.length) return { presenterId:'', presenterName:'', producerId:'', producerName:'' };
  if (ids.length === 1) {
    const onlyId = ids[0];
    return {
      presenterId:'',
      presenterName: room.hostName || 'Test Presenter',
      producerId: onlyId,
      producerName: room.players.get(onlyId)?.name || ''
    };
  }
  const presenterId = ids[room.turnCursor % ids.length];
  let producerId = ids[(room.turnCursor + 1) % ids.length];
  if (producerId === presenterId) producerId = ids.find(id => id !== presenterId) || '';
  return {
    presenterId,
    presenterName: room.players.get(presenterId)?.name || '',
    producerId,
    producerName: room.players.get(producerId)?.name || ''
  };
}
function advanceTurnOrder(room, anchorProducerId = '') {
  syncTurnOrder(room);
  const ids = room.turnOrder || [];
  if (ids.length < 2) return;
  if (anchorProducerId && ids.includes(anchorProducerId)) room.turnCursor = ids.indexOf(anchorProducerId);
  else room.turnCursor = (room.turnCursor + 1) % ids.length;
}
function completeVote(v) { return v && [v.funny, v.convincing, v.recovery].every(n => Number(n) >= 1); }
function publicState(room, clientId, host = false) {
  cleanRoom(room);
  const r = room.round;
  const meRaw = clientId ? room.players.get(clientId) : null;
  let role = 'audience';
  if (clientId && clientId === r.producerId) role = 'producer';
  if (clientId && clientId === r.presenterId) role = 'presenter';
  const nextPair = suggestedPair(room);
  const state = {
    code: room.code, subject: room.subject, hostName: room.hostName || '', locked: !!room.locked, allowActions: room.allowActions !== false, profanityFilter: true, imageEngine: imageEngineStatus(room), phase: r.phase, roundId: r.roundId,
    presenter: r.presenter, presenterId: r.presenterId, producerName: r.producerName,
    topic: r.topic, packId: r.packId, slideNumber: r.slideNumber, totalSlides: 4, stageLabel: stageLabel(r.slideNumber || 1), revealed: r.revealed, introStartedAt: r.introStartedAt || 0, introChoiceReady: !!r.pendingChoice,
    nextChoiceReady: r.phase === 'presenting' && r.slideNumber < 4 && !!r.pendingChoice,
    performanceChallenge: r.revealed?.performance || null,
    performanceVoteCount: Object.keys(r.performanceVotes || {}).length,
    performanceTarget: performanceVoteTarget(room),
    performanceBonus: Number(r.performanceBonus || 0),
    ownPerformanceVote: !!(clientId && r.performanceVotes && r.performanceVotes[clientId]),
    counts: { total: room.players.size },
    nextPresenterId: nextPair.presenterId, nextPresenterName: nextPair.presenterName,
    nextProducerId: nextPair.producerId, nextProducerName: nextPair.producerName,
    me: meRaw ? { name: meRaw.name, role } : null,
    voteCount: Object.values(r.votes).filter(completeVote).length,
    result: r.result,
    ownVote: clientId ? (r.votes[clientId] || {}) : {}
  };
  if (host) {
    state.reactionTotals = r.reactions.reduce((a,x) => { a[x.emoji]=(a[x.emoji]||0)+1; return a; }, {});
    state.players = playerList(room);
    state.reactions = r.reactions.slice(-40);
  } else if (role === 'producer') {
    const canPrepare = r.phase === 'intro' || (r.phase === 'presenting' && r.slideNumber < 4) || r.phase === 'choosing';
    state.introSelected = r.phase === 'intro' && !!r.pendingChoice;
    state.nextSelected = r.phase === 'presenting' && r.slideNumber < 4 && !!r.pendingChoice;
    if (canPrepare && r.packId) {
      const targetSlide=producerTargetSlideNumber(room);
      const slideData=producerSlideData(room);
      state.producerTargetSlide=targetSlide;
      state.producerStageLabel=stageLabel(targetSlide);
      state.currentPrompt=slideData.question;
      if (room.allowActions !== false) state.actionSuggestions=actionSuggestions(room);
      state.pendingPerformance = r.pendingPerformance || null;
    }
  }
  return state;
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 900000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}
function roomOr404(code, res) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) json(res, 404, { error: 'Room not found' });
  return room;
}
function checkHost(room, token, res) {
  if (!token || token !== room.hostToken) { json(res, 403, { error: 'Host token invalid' }); return false; }
  return true;
}
function lanUrls() {
  const urls = [];
  const port = ACTIVE_PORT || REQUESTED_PORT;
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${port}`);
  }
  return urls;
}

async function api(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, version: BUILD_VERSION });
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { port: ACTIVE_PORT || REQUESTED_PORT, lanUrls: lanUrls(), version: BUILD_VERSION });

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(req);
      const requestedSubject = String(body.subject || '').trim();
      const subject = ['games','film','esports','sports'].includes(requestedSubject) ? requestedSubject : 'games';
      const hostName = String(body.hostName || '').trim().replace(/\s+/g,' ').slice(0,24);
      if (hostName && !classroomSafeOrError(res, hostName, 'That host name')) return;
      const code = roomCode();
      const room = {
        code, subject, hostName, locked: false, allowActions: true, hostToken: randomId(18), createdAt: Date.now(), players: new Map(),
        usedTopics: new Set(), turnOrder: [], turnCursor: 0, round: emptyRound()
      };
      rooms.set(code, room);
      return json(res, 200, { code, hostToken: room.hostToken, state: publicState(room, null, true) });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const room = roomOr404(body.code, res); if (!room) return;
      if (room.locked) return json(res, 423, { error: 'This room is locked. Ask the host to reopen joining.' });
      const name = String(body.name || '').trim().replace(/\s+/g,' ').slice(0, 24) || 'Player';
      if (!classroomSafeOrError(res, name, 'That player name')) return;
      const clientId = randomId(12);
      room.players.set(clientId, { name, lastSeen: Date.now() });
      syncTurnOrder(room);
      return json(res, 200, { clientId, state: publicState(room, clientId) });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const room = roomOr404(url.searchParams.get('code'), res); if (!room) return;
      const clientId = url.searchParams.get('clientId') || '';
      const hostToken = url.searchParams.get('hostToken') || '';
      if (clientId && room.players.has(clientId)) room.players.get(clientId).lastSeen = Date.now();
      return json(res, 200, publicState(room, clientId, hostToken === room.hostToken));
    }

    if (req.method === 'POST' && url.pathname === '/api/leave') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room) return;
      if (b.clientId) room.players.delete(b.clientId);
      syncTurnOrder(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/host/lock') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      room.locked = !!b.locked;
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/actions') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      room.allowActions = !!b.enabled;
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/start') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      const joined = [...room.players.entries()];
      if (!joined.length) return json(res, 400, { error: 'At least one phone needs to join first.' });

      // The server owns the defaults. The host page can suggest roles, but a stale
      // dropdown or cleared field must never make Start fail.
      const nextPair = suggestedPair(room);
      let producerId = String(b.producerId || '');
      if (!room.players.has(producerId)) producerId = nextPair.producerId || joined[0][0];
      const producer = room.players.get(producerId);

      let presenterId = String(b.presenterId || '');
      let presenter = String(b.presenterName || '').trim().replace(/\s+/g,' ').slice(0,30);
      if (presenter && !classroomSafeOrError(res, presenter, 'That presenter name')) return;
      if (presenterId === '__HOST__' && room.hostName) {
        presenter = room.hostName;
        presenterId = '';
      } else if (presenterId && room.players.has(presenterId) && presenterId !== producerId) {
        presenter = room.players.get(presenterId).name;
      } else {
        presenterId = '';
      }

      if (!presenter) {
        if (nextPair.presenterId && nextPair.presenterId !== producerId) {
          presenterId = nextPair.presenterId;
          presenter = nextPair.presenterName;
        } else {
          const other = joined.find(([id]) => id !== producerId);
          if (other) {
            presenterId = other[0];
            presenter = other[1].name;
          } else {
            presenterId = '';
            presenter = room.hostName || 'Test Presenter';
          }
        }
      }

      // If a stale host selection somehow points both roles at the same player,
      // recover rather than refusing to start.
      if (presenterId === producerId) {
        const other = joined.find(([id]) => id !== producerId);
        if (other) {
          presenterId = other[0];
          presenter = other[1].name;
        } else {
          presenterId = '';
          presenter = room.hostName || 'Test Presenter';
        }
      }

      room.locked = true;
      const pack = pickPresentationPack(room);
      const topic = pack.title;
      room.round = {
        phase: 'intro', presenter, presenterId, producerId, producerName: producer.name,
        topic, packId: pack.id, slideNumber: 1, pendingChoice: null, pendingPerformance: null, revealed: null, introStartedAt: Date.now(),
        votes: {}, result: null, reactions: [], roundId: randomId(5), performanceVotes: {}, performanceBonus: 0
      };
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/producer/text') {
      const b=await readJson(req); const room=roomOr404(b.code,res); if(!room) return;
      const p=room.players.get(b.clientId);
      if(!p || b.clientId!==room.round.producerId) return json(res,403,{error:'Only this round’s Producer can set the surprise.'});
      const canPrepare = room.round.phase === 'intro' || room.round.phase === 'choosing' || (room.round.phase === 'presenting' && room.round.slideNumber < 4);
      if(!canPrepare) return json(res,409,{error:'There is no next surprise to prepare right now.'});
      const slideData=producerSlideData(room);
      const rawText=String(b.text||'').trim().slice(0,180);
      if(!rawText) return json(res,400,{error:'Type something for the Presenter to react to.'});
      if(!classroomSafeOrError(res, rawText, 'That surprise')) return;
      const choice=textChoice(rawText,slideData.question);
      if(!choice.text) return json(res,400,{error:'Type something for the Presenter to react to.'});
      room.round.pendingChoice=choice;
      return json(res,200,publicState(room,b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/producer/draw') {
      const b=await readJson(req); const room=roomOr404(b.code,res); if(!room) return;
      const p=room.players.get(b.clientId);
      if(!p || b.clientId!==room.round.producerId) return json(res,403,{error:'Only this round’s Producer can set the surprise.'});
      const canPrepare = room.round.phase === 'intro' || room.round.phase === 'choosing' || (room.round.phase === 'presenting' && room.round.slideNumber < 4);
      if(!canPrepare) return json(res,409,{error:'There is no next surprise to prepare right now.'});
      const dataUrl=String(b.dataUrl||'');
      if(!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) return json(res,400,{error:'That drawing could not be read. Clear it and try again.'});
      if(dataUrl.length > 600000) return json(res,413,{error:'That drawing is too large. Clear it and try again.'});
      const slideData=producerSlideData(room);
      room.round.pendingChoice=drawingChoice(dataUrl,slideData.question);
      return json(res,200,publicState(room,b.clientId));
    }


    if (req.method === 'POST' && url.pathname === '/api/producer/action') {
      const b=await readJson(req); const room=roomOr404(b.code,res); if(!room) return;
      const p=room.players.get(b.clientId);
      if(!p || b.clientId!==room.round.producerId) return json(res,403,{error:'Only this round’s Producer can set the surprise.'});
      if(room.allowActions === false) return json(res,403,{error:'Action prompts are switched off by the host.'});
      const canPrepare = room.round.phase === 'intro' || room.round.phase === 'choosing' || (room.round.phase === 'presenting' && room.round.slideNumber < 4);
      if(!canPrepare) return json(res,409,{error:'There is no next surprise to prepare right now.'});
      const slideData=producerSlideData(room);
      let rawText=String(b.text||'').trim().replace(/\s+/g,' ').slice(0,180);
      if(!rawText) return json(res,400,{error:'Choose or write a performance challenge first.'});
      const builtIns=actionPrompts[room.subject] || actionPrompts.games;
      const isBuiltIn=builtIns.includes(rawText);
      if(!isBuiltIn && !classroomSafeOrError(res, rawText, 'That performance challenge')) return;
      room.round.pendingPerformance=actionChoice(rawText,slideData.question);
      return json(res,200,publicState(room,b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/producer/action/clear') {
      const b=await readJson(req); const room=roomOr404(b.code,res); if(!room) return;
      const p=room.players.get(b.clientId);
      if(!p || b.clientId!==room.round.producerId) return json(res,403,{error:'Only this round’s Producer can change the performance challenge.'});
      room.round.pendingPerformance = null;
      return json(res,200,publicState(room,b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/cat') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      const r = room.round;
      if (r.phase !== 'presenting' || !r.revealed) return json(res, 409, { error: 'There is no revealed surprise to replace right now.' });
      r.revealed = {
        ...r.revealed,
        kind: 'image',
        id: `teacher-cat-${randomId(4)}`,
        title: 'Teacher Cat Override',
        provider: 'Local classroom override',
        credit: '', license: '', sourcePage: '',
        url: '/assets/teacher-cat.svg',
        fallback: 'teacher-cat.svg',
        text: ''
      };
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/next') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      const r = room.round;
      if (r.phase === 'intro') {
        if (!r.pendingChoice) return json(res, 409, { error: 'The Producer has not chosen the first surprise yet.' });
        r.revealed = { ...r.pendingChoice, performance: r.pendingPerformance || null };
        r.pendingChoice = null;
        r.pendingPerformance = null;
        r.performanceVotes = {};
        r.phase = 'presenting';
      } else {
        if (r.phase !== 'presenting') return json(res, 409, { error: 'No revealed slide to advance from.' });
        settlePerformanceBonus(room);
        if (r.slideNumber >= 4) {
          r.phase = 'voting'; r.revealed = null; r.pendingChoice=null; r.pendingPerformance=null;
        } else {
          if (!r.pendingChoice) return json(res, 409, { error: 'The Producer is still preparing the next surprise.' });
          r.slideNumber += 1;
          r.revealed = { ...r.pendingChoice, performance: r.pendingPerformance || null };
          r.pendingChoice = null;
          r.pendingPerformance = null;
          r.performanceVotes = {};
          r.phase = 'presenting';
        }
      }
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/react') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room) return;
      const p = room.players.get(b.clientId);
      if (!p) return json(res, 403, { error: 'Join the room first.' });
      if (!['choosing','presenting'].includes(room.round.phase)) return json(res, 409, { error: 'Reactions are only open during the presentation.' });
      const allowed = ['😂','💀','👏','🔥'];
      const emoji = allowed.includes(b.emoji) ? b.emoji : null;
      if (!emoji) return json(res, 400, { error: 'Reaction not recognised.' });
      const now = Date.now();
      const last = p.lastReaction || 0;
      if (now - last < 350) return json(res, 429, { error: 'Easy! Give it a moment.' });
      p.lastReaction = now;
      room.round.reactions.push({ id: randomId(4), emoji, at: now });
      if (room.round.reactions.length > 120) room.round.reactions.splice(0, room.round.reactions.length - 120);
      return json(res, 200, publicState(room, b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/performance') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room) return;
      const p = room.players.get(b.clientId);
      if (!p) return json(res, 403, { error: 'Join the room first.' });
      if (room.round.phase !== 'presenting' || !room.round.revealed?.performance) return json(res, 409, { error: 'No performance challenge is live right now.' });
      if (b.clientId === room.round.presenterId) return json(res, 403, { error: 'The Presenter cannot score their own performance bonus.' });
      room.round.performanceVotes ||= {};
      room.round.performanceVotes[b.clientId] = true;
      return json(res, 200, publicState(room, b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/vote') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room) return;
      const p = room.players.get(b.clientId);
      if (!p) return json(res, 403, { error: 'Join the room first.' });
      if (room.round.phase !== 'voting') return json(res, 409, { error: 'Voting is not open.' });
      const category = ['funny','convincing','recovery'].includes(b.category) ? b.category : null;
      const rating = Number(b.rating);
      if (!category || !Number.isInteger(rating) || rating < 1 || rating > 5) return json(res, 400, { error: 'Choose a rating from 1 to 5.' });
      room.round.votes[b.clientId] ||= {};
      room.round.votes[b.clientId][category] = rating;
      return json(res, 200, publicState(room, b.clientId));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/results') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      const votes = Object.values(room.round.votes).filter(completeVote);
      const avg = key => {
        const vals = votes.map(v => Number(v[key])).filter(n => n >= 1 && n <= 5);
        return vals.length ? Math.round((vals.reduce((a,n)=>a+n,0) / vals.length) * 10) / 10 : 0;
      };
      const funny = avg('funny'), convincing = avg('convincing'), recovery = avg('recovery');
      const nonzero = [funny, convincing, recovery].filter(Boolean);
      const overall = nonzero.length ? Math.round((nonzero.reduce((a,n)=>a+n,0)/nonzero.length)*10)/10 : 0;
      const performanceBonus = Math.round(Number(room.round.performanceBonus || 0) * 10) / 10;
      const finalOverall = Math.round((overall + performanceBonus) * 10) / 10;
      room.round.result = { funny, convincing, recovery, overall, performanceBonus, finalOverall, votes: votes.length };
      room.round.phase = 'results';
      return json(res, 200, publicState(room, null, true));
    }

    if (req.method === 'POST' && url.pathname === '/api/host/lobby') {
      const b = await readJson(req); const room = roomOr404(b.code, res); if (!room || !checkHost(room, b.hostToken, res)) return;
      const previousProducerId = room.round.producerId || '';
      if (room.round.phase !== 'lobby') advanceTurnOrder(room, previousProducerId);
      room.round = emptyRound();
      return json(res, 200, publicState(room, null, true));
    }

    json(res, 404, { error: 'API endpoint not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Server error' });
  }
}


function serveImageCache(req, res, url) {
  const name = path.basename(decodeURIComponent(url.pathname.replace('/image-cache/','')));
  const file = path.join(IMAGE_CACHE_DIR, name);
  if (!file.startsWith(IMAGE_CACHE_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'})[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = ({
      '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8',
      '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp'
    })[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, version: BUILD_VERSION });
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (url.pathname.startsWith('/image-cache/')) return serveImageCache(req, res, url);
  serveStatic(req, res, url);
});

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60 * 8;
  for (const [code, room] of rooms) if (room.createdAt < cutoff) rooms.delete(code);
}, 1000 * 60 * 10).unref();

server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

server.listen(REQUESTED_PORT, '0.0.0.0', () => {
  ACTIVE_PORT = server.address().port;
  console.log(`\nTalking Points Classroom V${BUILD_VERSION} is running.`);
  console.log(`Host: http://localhost:${ACTIVE_PORT}`);
  const urls = lanUrls();
  if (urls.length) {
    console.log('Phones on the same network can use:');
    urls.forEach(u => console.log(`  ${u}`));
  }
  console.log('\nKeep this window open while you play.\n');

  // Windows classroom convenience: open the exact fresh server URL. Using an
  // automatically assigned free port prevents an older Talking Points server
  // from silently stealing the browser session.
  if (process.platform === 'win32') {
    const { exec } = require('child_process');
    exec(`start "" "http://localhost:${ACTIVE_PORT}"`);
  }
});
