require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { pool, query } = require('./db');
const app = express();
// Railway terminates HTTPS at its reverse proxy. Trust the single proxy hop.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/../views');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname + '/../public'));
app.use(session({
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: 'Слишком много попыток. Попробуйте позже.' });
const assistantLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много вопросов подряд. Попробуйте позже.' } });

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.message = req.query.message || '';
  res.locals.error = req.query.error || '';
  res.locals.path = req.path;
  res.locals.lang = req.session.lang || 'ru';
  res.locals.turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || ''; 
  res.locals.t = (ru, by) => res.locals.lang === 'by' ? by : ru;
  if (req.session.user) {
    try {
      const n = await query('SELECT COUNT(*)::int AS count FROM notifications WHERE (user_id=$1 OR (user_id IS NULL AND school_id=$2)) AND read_at IS NULL', [req.session.user.id, req.session.user.school_id]);
      res.locals.unread = n.rows[0].count;
    } catch { res.locals.unread = 0; }
  } else res.locals.unread = 0;
  next();
});
function requireAuth(req,res,next){ if(!req.session.user) return res.redirect('/login'); next(); }
function requireAdmin(req,res,next){ if(!req.session.user || !['admin','staff'].includes(req.session.user.role)) return res.status(403).render('error',{title:'Нет доступа',message:'Этот раздел доступен только администрации.'}); next(); }
function requireMainAdmin(req,res,next){ if(!req.session.user || req.session.user.role!=='admin') return res.status(403).render('error',{title:'Нет доступа',message:'Требуются права главного администратора.'}); next(); }
function requireSchool(req,res,next){ if(!req.session.user || req.session.user.role!=='school') return res.status(403).render('error',{title:'Нет доступа',message:'Раздел доступен только школе.'}); next(); }
function redirectMsg(res,path,message){ res.redirect(path + (path.includes('?')?'&':'?') + 'message=' + encodeURIComponent(message)); }
async function audit(user, action, entity=null, entityId=null, details={}) { try { await query('INSERT INTO audit_log(actor_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)',[user?.id||null,action,entity,entityId,JSON.stringify(details)]); } catch(e){ console.error('audit:',e.message); } }
async function notify({userId=null,schoolId=null,title,body}) { await query('INSERT INTO notifications(user_id,school_id,title,body) VALUES($1,$2,$3,$4)',[userId,schoolId,title,body]); }
async function awardEligibleAchievements(schoolId){
 const metrics=await query(`SELECT
  (SELECT COALESCE(SUM(quantity),0) FROM collection_entries WHERE school_id=$1 AND status='approved') kg,
  (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE school_id=$1) points,
  (SELECT COUNT(*) FROM mission_submissions WHERE school_id=$1 AND status='approved') missions`,[schoolId]);
 const v=metrics.rows[0];
 const gained=await query(`INSERT INTO school_achievements(school_id,achievement_id)
  SELECT $1,id FROM eco_achievements
  WHERE threshold_kg<=$2 AND threshold_points<=$3 AND threshold_missions<=$4
  ON CONFLICT(school_id,achievement_id) DO NOTHING RETURNING achievement_id`,[schoolId,v.kg,v.points,v.missions]);
 if(gained.rowCount){
  const names=await query('SELECT title_ru FROM eco_achievements WHERE id=ANY($1::bigint[])',[gained.rows.map(x=>x.achievement_id)]);
  await notify({schoolId,title:'Новое экологическое достижение!',body:'Школа получила награду: '+names.rows.map(x=>x.title_ru).join(', ')});
 }
}
const SCHOOL_AVATARS=[
 {code:'sprout',name:'Росток',nameBy:'Парастак',icon:'🌱',points:0},
 {code:'fox',name:'Эко-лис',nameBy:'Эка-ліс',icon:'🦊',points:25},
 {code:'owl',name:'Мудрая сова',nameBy:'Мудрая сава',icon:'🦉',points:75},
 {code:'wolf',name:'Лесной волк',nameBy:'Лясны воўк',icon:'🐺',points:150},
 {code:'dragon',name:'Зелёный дракон',nameBy:'Зялёны цмок',icon:'🐉',points:300},
 {code:'phoenix',name:'Феникс природы',nameBy:'Фенікс прыроды',icon:'🔥',points:500}
];
async function verifyCaptcha(req){
  if(process.env.TURNSTILE_SECRET_KEY){
    const token=req.body['cf-turnstile-response'];
    if(!token) return false;
    const form=new URLSearchParams({secret:process.env.TURNSTILE_SECRET_KEY,response:token});
    try{const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});const result=await response.json();return result.success===true;}catch{return false;}
  }
  return String(req.body.answer)===String(req.session.captchaAnswer);
}
function monthStart(value){ const d=value?new Date(value+'T00:00:00'):new Date(); return new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10); }

function ecoBotAnswer(question){
 const original=String(question||'').trim();
 const q=original.toLowerCase().replace(/ё/g,'е').replace(/[^а-яa-z0-9 ]/gi,' ');
 const words=q.split(/\s+/).filter(Boolean);
 const has=(...terms)=>terms.some(term=>q.includes(term));
 const choose=(items)=>items[Math.abs([...q].reduce((n,c)=>n+c.charCodeAt(0),0))%items.length];
 if(has('привет','здравствуй','добрый день','доброе утро','добрый вечер','салам')) return choose([
  'Привет! 🌱 Рад помочь. Можем разобраться с сортировкой, придумать экоакцию или обсудить экологическую проблему. Что хочешь узнать?',
  'Здравствуй! Я ЭКОБОТ ЭКОРАЙОНА. Напиши вопрос своими словами — постараюсь подсказать!',
  'Привет-привет! ♻️ Какую экологическую задачу решаем сегодня?'
 ]);
 if(has('кто ты','что ты умеешь','помощник','эко-бот','экобот')) return 'Я ЭКОБОТ 🌱 — бесплатный помощник платформы ЭКОРАЙОНА. Подсказываю по сортировке отходов, школьным экоакциям, заданиям и работе сайта. Я использую встроенную базу знаний, поэтому не вижу личные данные, текущие баллы и закрытую статистику.';
 if(has('батаре','аккумулятор','электрон','телефон','ламп')) return '🔋 **Батарейки и электроника**\n\nНе выбрасывай их в обычный мусор: сдавай в специальные пункты приёма. Не разбирай устройства и не вскрывай батареи. Попроси взрослого помочь найти официальный пункт сбора.\n\nПочему это важно: отдельный сбор позволяет безопаснее обращаться с такими отходами и возвращать часть материалов в переработку.';
 if(has('макулатур','бумаг','картон','тетрад')) return '📚 **Бумага и макулатура**\n\n1. Отложи чистую и сухую бумагу и картон.\n2. Удали пластиковые файлы, обложки и скрепки, если этого требуют правила пункта приёма.\n3. Не смешивай бумагу с пищевыми отходами.\n4. Передай собранное организаторам или в пункт приёма.\n\nМокрая, жирная и сильно загрязнённая бумага обычно не подходит. Уточни местные правила.';
 if(has('стекл','банку','стеклян')) return '🫙 **Стекло**\n\nБутылки и банки обычно собирают отдельно. Опорожни тару и следуй указаниям контейнера. Не пытайся самостоятельно собирать осколки — попроси взрослого.\n\nВажно: керамика, зеркала и оконное стекло могут приниматься по другим правилам, не клади их в контейнер для бутылок без проверки.';
 if(has('пластик','пэт','упаковк','пакет')) return '♻️ **Пластик и упаковка**\n\n- Проверь маркировку и список принимаемых материалов на контейнере.\n- Опорожни упаковку от содержимого.\n- При необходимости ополосни её и дай стечь воде.\n- Не смешивай разные виды пластика, если местные правила требуют разделения.\n\nНе вся пластиковая упаковка перерабатывается: ориентируйся на правила своего пункта приёма.';
 if(has('сортиров','разделять','раздельн','контейнер')) return '♻️ **С чего начать сортировку**\n\n1. Узнай, какие фракции принимают в твоём населённом пункте.\n2. Поставь отдельные ёмкости для тех материалов, которые действительно принимают.\n3. Перед сдачей опорожняй упаковку и отделяй загрязнённые отходы.\n4. Батарейки и электронику собирай отдельно.\n\nХорошая сортировка начинается не с количества контейнеров, а с понимания местных правил.';
 if(has('акци','мероприят','мероприяти','проект','школ','класс','команд')) return choose([
  '🌳 **Идея школьной экоакции: «Неделя без лишней бумаги»**\n\n- В первый день расскажите, как экономить бумагу.\n- Затем используйте обе стороны листа для черновиков.\n- Организуйте сбор чистой макулатуры.\n- В конце подведите итоги и поблагодарите участников.\n\nСогласуйте план с учителем и заранее уточните, куда передадите макулатуру.',
  '🌱 **Идея: экологический патруль**\n\nНебольшие команды изучают, правильно ли подписаны контейнеры в школе, готовят понятные памятки и предлагают улучшения администрации. Не трогайте мусор руками и не открывайте неизвестные ёмкости. Итогом может стать карта школьных точек раздельного сбора.',
  '🏫 **Идея: эко-квиз между классами**\n\nПодготовьте 10–15 вопросов о переработке, проведите короткую игру на перемене и добавьте практический раунд: определить, к какой фракции относится чистая упаковка. Проверяйте ответы по местным правилам приёма.'
 ]);
 if(has('балл','рейтинг','место','начисл','очки')) return '🏆 **Баллы и рейтинг ЭКОРАЙОНА**\n\nБаллы зависят от утверждённых администрацией тарифов и подтверждённых результатов. Я не подключён к базе начислений, поэтому не могу увидеть точный баланс или место школы. Открой раздел «Рейтинги» либо уточни у ответственного администратора. Если хочешь, могу объяснить, как обычно устроена система начисления баллов.';
 if(has('задани','мисси','экозадан','выполнить')) return '🎯 **Как выполнить эко-задание**\n\n1. Открой раздел «Эко-задания».\n2. Выбери доступное задание и прочитай условия.\n3. Выполни его безопасным способом; если нужно работать с отходами или оборудованием, попроси взрослого помочь.\n4. Отправь результат и подтверждение так, как указано на странице задания.\n\nПосле отправки дождись проверки, если она предусмотрена.';
 if(has('спасибо','благодар')) return choose(['Пожалуйста! 🌿 Здорово, что интересуешься экологией.','Рад, что пригодилось! Пусть полезных экоидей становится больше. ♻️','Всегда пожалуйста! Если появится новый вопрос, попробуем разобраться.']);
 if(has('факт','интересн')) return choose([
  '✨ Экофакт: алюминий можно перерабатывать многократно, а производство из вторичного сырья обычно требует намного меньше энергии, чем из руды.',
  '🌳 Экофакт: бумажные волокна постепенно укорачиваются при переработке, поэтому бумагу нельзя бесконечно перерабатывать без добавления нового волокна.',
  '♻️ Экофакт: самый экологичный предмет часто тот, который не пришлось покупать заново — повторное использование помогает сократить количество отходов.'
 ]);
 const topic=words.filter(w=>w.length>3).slice(0,5).join(', ');
 return 'Спасибо за вопрос: «'+original.slice(0,180)+'». 🌿\n\nВ моей бесплатной базе пока нет отдельной инструкции именно по этой теме'+(topic?' (ключевые слова: '+topic+')':'')+'. Я могу уверенно подсказать по сортировке бумаги, пластика и стекла, сбору батареек, школьным экоакциям, заданиям и общим правилам ЭКОРАЙОНА. Базу знаний можно расширить под новые вопросы.';
}
app.get('/assistant',(req,res)=>res.render('assistant',{title:req.session.lang==='by'?'Эка-памочнік':'Эко-помощник',assistantEnabled:true}));
app.post('/api/assistant',assistantLimiter,(req,res)=>{
 const raw=Array.isArray(req.body.messages)?req.body.messages:[];
 const last=raw.slice(-12).reverse().find(m=>m&&m.role==='user'&&typeof m.content==='string');
 if(!last||last.content.trim().length<2)return res.status(400).json({error:'Напишите вопрос, чтобы начать беседу.'});
 res.json({answer:ecoBotAnswer(last.content.slice(0,2500))});
});

app.get('/health',(req,res)=>res.json({ok:true,service:'ЭКОРАЙОН'}));
app.get('/language/:lang',(req,res)=>{ if(['ru','by'].includes(req.params.lang)) req.session.lang=req.params.lang; res.redirect('back'); });
app.get('/', async (req,res,next)=>{
 try {
  const [totals, schools, classes, leaders, news, pulseEvents] = await Promise.all([
   query(`SELECT COALESCE(SUM(quantity),0)::numeric(14,2) total FROM collection_entries WHERE status IN ('pending','approved') AND (SELECT status FROM schools WHERE id=school_id)='active'`),
   query(`SELECT COUNT(*)::int count FROM schools WHERE status='active'`),
   query(`SELECT COUNT(*)::int count FROM classes WHERE active=true AND school_id IN (SELECT id FROM schools WHERE status='active')`),
   query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 3`),
   query(`SELECT n.*,s.name school_name FROM news n LEFT JOIN schools s ON s.id=n.school_id WHERE n.status='published' ORDER BY n.created_at DESC LIMIT 4`),
   loadPulseEvents(3)
  ]);
  res.render('home',{title:'ЭКОРАЙОН',total:totals.rows[0].total,schoolCount:schools.rows[0].count,classCount:classes.rows[0].count,leaders:leaders.rows,news:news.rows,pulseEvents});
 } catch(e){next(e)}
});
app.get('/mission-earth',async(req,res,next)=>{try{
 const [totals,schools,classes,missions,leaders]=await Promise.all([
  query(`SELECT COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM collection_entries e JOIN schools s ON s.id=e.school_id WHERE e.status IN ('pending','approved') AND s.status='active'`),
  query("SELECT COUNT(*)::int count FROM schools WHERE status='active'"),
  query("SELECT COUNT(*)::int count FROM classes WHERE active=true AND school_id IN (SELECT id FROM schools WHERE status='active')"),
  query("SELECT COUNT(*)::int count FROM mission_submissions m JOIN schools s ON s.id=m.school_id WHERE m.status='approved' AND s.status='active'"),
  query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 5`)
 ]);
 const total=Number(totals.rows[0].total)||0;
 const milestones=[100,250,500,1000,2500,5000];
 const nextMilestone=milestones.find(x=>total<x)||Math.ceil((total+1)/5000)*5000;
 const previous=milestones.filter(x=>x<nextMilestone).slice(-1)[0]||0;
 const progress=Math.max(0,Math.min(100,Math.round((total-previous)/(nextMilestone-previous)*100)));
 const maxLeader=Math.max(0,...leaders.rows.map(x=>Number(x.total)||0));
 res.render('mission-earth',{title:'Миссия «Земля»',total,schoolCount:schools.rows[0].count,classCount:classes.rows[0].count,missionCount:missions.rows[0].count,leaders:leaders.rows,maxLeader,nextMilestone,progress,milestones});
 }catch(e){next(e)}});
app.get('/future-professions',(req,res)=>res.render('future-professions',{title:'Профессии будущего'}));
app.get('/about',(req,res)=>res.render('page',{title:req.session.lang==='by'?'Пра праект':'О проекте',body:req.session.lang==='by'?'ЭКАРАЁН аб’ядноўвае школы раёна ў агульнай экалагічнай ініцыятыве. Мы ўлічваем збор другаснай сыравіны, дзелімся вынікамі і падтрымліваем адказнае стаўленне да навакольнага асяроддзя.':'ЭКОРАЙОН объединяет школы района в общей экологической инициативе. Мы учитываем фактический сбор вторсырья, делимся результатами и поддерживаем ответственное отношение к окружающей среде.'}));
app.get('/rules',(req,res)=>{const by=req.session.lang==='by';const sections=by?[
{heading:'Хто можа ўдзельнічаць',text:'Да праекта далучаюцца школы і адукацыйныя ўстановы раёна. Ад кожнай школы пажадана вызначыць адказнага дарослага каардынатара, які працуе з кабінетам і правярае даныя перад адпраўкай.'},
{heading:'Як далучыцца',text:'Адпраўце заяўку на рэгістрацыю школы. Адміністрацыя праверыць інфармацыю і звяжацца з указаным кантактам. Пасля стварэння ўліковага запісу адказны прадстаўнік атрымае даныя для ўваходу.'},
{heading:'Як дадаваць збор',text:'У кабінеце выберыце «Дадаць збор», пазначце від другаснай сыравіны, колькасць, справаздачны перыяд і пры неабходнасці клас. Указвайце фактычныя вымераныя значэнні і не адпраўляйце адну і тую ж партыю паўторна.'},
{heading:'Праверка і статусы',text:'Новы запіс спачатку мае статус чакання праверкі. Адміністратар можа пацвердзіць яго або вярнуць на выпраўленне з каментарыем. Да пацвярджэння вынік можа паказвацца як папярэдні і не лічыцца канчатковым.'},
{heading:'Рэйтынгі і балы',text:'Рэйтынгі па зборы заснаваныя на пацверджанай масе другаснай сыравіны. Матывацыйныя балы налічваюцца паводле дзейных тарыфаў і зацверджаных дадатковых актыўнасцей. Адміністрацыя можа змяняць тарыфы; новыя значэнні не пералічваюць ранейшыя налічэнні.'},
{heading:'Граматы і сумленны ўдзел',text:'Пасля пацвярджэння запісу сістэма можа сфарміраваць грамату, даступную ў кабінеце. Забараняецца ўносіць выдуманыя даныя, завышаць вагу, дубляваць запісы або выдаваць чужы вынік за свой. Пры памылцы звярніцеся да адміністрацыі праз форму зваротнай сувязі.'}
]:[
{heading:'Кто может участвовать',text:'К проекту подключаются школы и образовательные учреждения района. От каждой школы желательно назначить ответственного взрослого координатора, который работает с кабинетом и проверяет данные перед отправкой.'},
{heading:'Как присоединиться',text:'Отправьте заявку на регистрацию школы. Администрация проверит информацию и свяжется по указанному контакту. После создания учётной записи ответственный представитель получит данные для входа.'},
{heading:'Как добавлять сбор',text:'В кабинете выберите «Добавить сбор», укажите вид вторсырья, количество, отчётный период и при необходимости класс. Вносите фактически измеренные значения и не отправляйте одну и ту же партию повторно.'},
{heading:'Проверка и статусы',text:'Новая запись сначала получает статус ожидания проверки. Администратор может подтвердить её или вернуть на исправление с комментарием. До подтверждения результат может отображаться как предварительный и не считается окончательным.'},
{heading:'Рейтинги и баллы',text:'Рейтинги по сбору основаны на подтверждённой массе вторсырья. Мотивационные баллы начисляются по действующим тарифам и за подтверждённые дополнительные активности. Администрация может менять тарифы; новые значения не пересчитывают прежние начисления.'},
{heading:'Грамоты и честное участие',text:'После подтверждения записи система может сформировать грамоту, доступную в кабинете. Нельзя вносить вымышленные данные, завышать вес, дублировать записи или выдавать чужой результат за свой. Если заметили ошибку, обратитесь к администрации через форму обратной связи.'}
];res.render('page',{title:by?'Правілы ўдзелу':'Правила участия',body:by?'Асноўныя ўмовы ўдзелу ў экалагічным праекце.':'Понятные правила для школ, координаторов и участников проекта.',sections});});
app.get('/help-info',(req,res)=>{const by=req.session.lang==='by';const sections=by?[
{heading:'Папера і кардон',text:'Збірайце паперу асобна ад вільготных і забруджаных адходаў. Па магчымасці складвайце кардон, каб ён займаў менш месца. Перад здачай удакладніце, якія віды паперы прымае мясцовы пункт.'},
{heading:'Пластык і ўпакоўка',text:'Правярайце маркіроўку і мясцовыя правілы прыёму: не кожны пластыкавы выраб перапрацоўваецца ўсюды. Апаражніце ўпакоўку, калі гэта бяспечна і магчыма, і не змешвайце розныя матэрыялы без неабходнасці.'},
{heading:'Шкло і метал',text:'Збірайце шкляную і металічную ўпакоўку асобна, калі гэта прадугледжана сістэмай збору ў вашым населеным пункце. Не кладзіце ў кантэйнеры прадметы, якія не прымаюцца мясцовым аператарам.'},
{heading:'Батарэйкі і электроніка',text:'Гэта асобныя катэгорыі адходаў. Не выкідайце батарэйкі і электронныя прылады ў звычайны сметнік і не разбірайце іх. Перадавайце іх у спецыяльныя пункты збору або на афіцыйныя акцыі прыёму.'},
{heading:'Як арганізаваць збор у школе',text:'Прызначце адказнага дарослага, узгадніце месца і тэрміны збору, падпішыце ёмістасці і растлумачце ўдзельнікам, што можна прыносіць. Захоўвайце матэрыялы сухімі і ў бяспечным месцы.'},
{heading:'Як правільна ўзважыць',text:'Выкарыстоўвайце спраўныя шалі, запісвайце вынік у кілаграмах і не ўключайце вагу тары. Калі вынік атрыманы ў іншых адзінках, пералічыце яго перад унясеннем у платформу. Захоўвайце запіс вымярэння да праверкі.'},
{heading:'Важна памятаць',text:'Правілы прыёму адрозніваюцца ў залежнасці ад рэгіёна і перапрацоўшчыка. Заўсёды правярайце мясцовыя патрабаванні. Не чапайце невядомыя, пашкоджаныя або небяспечныя адходы — паведаміце даросламу адказнаму.'}
]:[
{heading:'Бумага и картон',text:'Собирайте бумагу отдельно от влажных и загрязнённых отходов. По возможности складывайте картон, чтобы он занимал меньше места. Перед сдачей уточните, какие виды бумаги принимает местный пункт.'},
{heading:'Пластик и упаковка',text:'Проверяйте маркировку и местные правила приёма: не каждое пластиковое изделие перерабатывается повсюду. Опустошите упаковку, если это безопасно и возможно, и не смешивайте разные материалы без необходимости.'},
{heading:'Стекло и металл',text:'Собирайте стеклянную и металлическую упаковку отдельно, если это предусмотрено системой сбора в вашем населённом пункте. Не кладите в контейнеры предметы, которые не принимает местный оператор.'},
{heading:'Батарейки и электроника',text:'Это отдельные категории отходов. Не выбрасывайте батарейки и электронные устройства в обычный мусор и не разбирайте их. Передавайте их в специальные пункты сбора или на официальные акции приёма.'},
{heading:'Как организовать сбор в школе',text:'Назначьте ответственного взрослого, согласуйте место и сроки сбора, подпишите ёмкости и объясните участникам, что можно приносить. Храните материалы сухими и в безопасном месте.'},
{heading:'Как правильно взвесить',text:'Используйте исправные весы, записывайте результат в килограммах и не включайте вес тары. Если результат получен в других единицах, пересчитайте его перед внесением в платформу. Сохраняйте запись измерения до проверки.'},
{heading:'Важно помнить',text:'Правила приёма отличаются в зависимости от региона и переработчика. Всегда проверяйте местные требования. Не трогайте неизвестные, повреждённые или потенциально опасные отходы — сообщите ответственному взрослому.'}
];res.render('page',{title:by?'Карысная інфармацыя':'Полезная информация',body:by?'Практычныя парады па сартаванні, школьным зборам і працы з платформай.':'Про сортировку, подготовку вторсырья и организацию экологических акций.',sections});});
app.get('/calendar',(req,res)=>res.render('page',{title:req.session.lang==='by'?'Экалагічны каляндар':'Экологический календарь',body:req.session.lang==='by'?'Тут публікуюцца раённыя экалагічныя даты, будучыя акцыі і мерапрыемствы школ.':'Здесь публикуются районные экологические даты, предстоящие акции и мероприятия школ.'}));
app.get('/contacts',(req,res)=>res.render('page',{title:req.session.lang==='by'?'Кантакты':'Контакты',body:req.session.lang==='by'?'Кантакты раённага каардынатара будуць дададзены адміністрацыяй.':'Контакты районного координатора будут добавлены администрацией после запуска проекта.'}));
app.get('/eco-world',async(req,res,next)=>{try{
 const [totals,schools,achievements]=await Promise.all([
  query(`SELECT
   (SELECT COALESCE(SUM(quantity),0)::numeric(14,2) FROM collection_entries WHERE status='approved') kg,
   (SELECT COUNT(*)::int FROM schools WHERE status='active') schools,
   (SELECT COALESCE(SUM(points),0)::numeric(14,2) FROM point_ledger) points,
   (SELECT COUNT(*)::int FROM school_achievements) badges`),
  query(`SELECT s.id,s.name,s.locality,s.address,
   (SELECT COALESCE(SUM(e.quantity),0)::numeric(14,2) FROM collection_entries e WHERE e.school_id=s.id AND e.status='approved') kg,
   (SELECT COALESCE(SUM(l.points),0)::numeric(14,2) FROM point_ledger l WHERE l.school_id=s.id) points
   FROM schools s WHERE s.status='active' ORDER BY kg DESC,s.name LIMIT 30`),
  query(`SELECT a.id,a.icon,a.title_ru,a.title_by,a.description_ru,a.description_by,COUNT(sa.id)::int earned_count
   FROM eco_achievements a LEFT JOIN school_achievements sa ON sa.achievement_id=a.id
   GROUP BY a.id ORDER BY a.threshold_kg,a.id`)
 ]);
 let myStats=null;
 if(req.session.user?.role==='school'){
  const r=await query(`SELECT s.name school_name,
   (SELECT COALESCE(SUM(points),0)::numeric(14,2) FROM point_ledger WHERE school_id=s.id) points,
   (SELECT COALESCE(SUM(quantity),0)::numeric(14,2) FROM collection_entries WHERE school_id=s.id AND status='approved') kg,
   (SELECT COUNT(*)::int FROM school_achievements WHERE school_id=s.id) badges,
   (SELECT COUNT(*)::int+1 FROM schools x WHERE x.status='active' AND
    (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE school_id=x.id)>
    (SELECT COALESCE(SUM(points),0) FROM point_ledger WHERE school_id=s.id)) rank
   FROM schools s WHERE s.id=$1 AND s.status='active'`,[req.session.user.school_id]);
  myStats=r.rows[0]||null;
 }
 res.render('eco-world',{title:'ЭКОМИР — твоя экологическая вселенная',totals:totals.rows[0],schools:schools.rows,achievements:achievements.rows,myStats});
 }catch(e){next(e)}});
app.get('/schools',async(req,res,next)=>{try{const r=await query(`SELECT s.*,COALESCE(SUM(e.quantity) FILTER (WHERE e.status IN ('pending','approved')),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id WHERE s.status='active' GROUP BY s.id ORDER BY s.name`);res.render('schools',{title:'Школы района',schools:r.rows});}catch(e){next(e)}});
app.get('/schools/:id',async(req,res,next)=>{try{const s=await query('SELECT * FROM schools WHERE id=$1 AND status=\'active\'',[req.params.id]);if(!s.rowCount)return res.status(404).render('error',{title:'Не найдено',message:'Школа не найдена.'});const [stats,classes,news]=await Promise.all([query(`SELECT m.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM materials m LEFT JOIN collection_entries e ON e.material_code=m.code AND e.school_id=$1 AND e.status IN ('pending','approved') GROUP BY m.code,m.name ORDER BY m.name`,[req.params.id]),query('SELECT * FROM classes WHERE school_id=$1 AND active=true ORDER BY name',[req.params.id]),query('SELECT * FROM news WHERE school_id=$1 AND status=\'published\' ORDER BY created_at DESC LIMIT 10',[req.params.id])]);res.render('school-detail',{title:s.rows[0].name,school:s.rows[0],stats:stats.rows,classes:classes.rows,news:news.rows});}catch(e){next(e)}});
app.get('/ratings',async(req,res,next)=>{try{const [r,m,classes,monthly,yearly,pointSchools]=await Promise.all([query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') WHERE s.status='active' GROUP BY s.id ORDER BY total DESC,s.name`),query(`SELECT m.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM materials m LEFT JOIN collection_entries e ON e.material_code=m.code AND e.status IN ('pending','approved') GROUP BY m.code,m.name ORDER BY total DESC`),query(`SELECT c.id,c.name class_name,s.id school_id,s.name school_name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM classes c JOIN schools s ON s.id=c.school_id LEFT JOIN collection_entries e ON e.class_id=c.id AND e.status IN ('pending','approved') WHERE c.active AND s.status='active' GROUP BY c.id,s.id ORDER BY total DESC,c.name`),query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') AND date_trunc('month',e.period_month)=date_trunc('month',CURRENT_DATE) WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 10`),query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') AND date_trunc('year',e.period_month)=date_trunc('year',CURRENT_DATE) WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 10`),query(`SELECT s.id,s.name,COALESCE(SUM(l.points),0)::numeric(14,2) points FROM schools s LEFT JOIN point_ledger l ON l.school_id=s.id WHERE s.status='active' GROUP BY s.id ORDER BY points DESC,s.name`)]);res.render('ratings',{title:'Рейтинги',schools:r.rows,materials:m.rows,classes:classes.rows,monthly:monthly.rows,yearly:yearly.rows,pointSchools:pointSchools.rows});}catch(e){next(e)}});
app.get('/search',async(req,res,next)=>{try{const term=(req.query.q||'').trim();if(!term)return res.render('search',{title:'Поиск',term,results:[]});const like='%'+term+'%';const r=await query(`SELECT * FROM (SELECT 'school' type,id,title,subtitle,url FROM (SELECT id,name title,COALESCE(locality,'') subtitle,'/schools/'||id url FROM schools WHERE status='active' AND (name ILIKE $1 OR locality ILIKE $1)) a UNION ALL SELECT 'news',id,title,category,'/news/'||id FROM news WHERE status='published' AND (title ILIKE $1 OR body ILIKE $1) UNION ALL SELECT 'class',c.id,c.name,s.name,'/schools/'||s.id FROM classes c JOIN schools s ON s.id=c.school_id WHERE c.active AND (c.name ILIKE $1 OR s.name ILIKE $1)) x ORDER BY title LIMIT 50`,[like]);res.render('search',{title:'Поиск',term,results:r.rows});}catch(e){next(e)}});

async function loadPulseEvents(limit=30){
 const r=await query(`SELECT * FROM (
  SELECT 'collection'::text kind,e.created_at happened_at,s.name school_name,
   'Подтверждён сбор вторсырья'::text title,
   m.name||' · '||e.quantity::text||' кг' detail,
   '/schools/'||s.id::text url
  FROM collection_entries e JOIN schools s ON s.id=e.school_id
  JOIN materials m ON m.code=e.material_code
  WHERE e.status='approved' AND s.status='active'
  UNION ALL
  SELECT 'achievement',sa.earned_at,s.name,
   'Получено достижение: '||a.title_ru,'Новое достижение школы','/schools/'||s.id::text
  FROM school_achievements sa JOIN schools s ON s.id=sa.school_id
  JOIN eco_achievements a ON a.id=sa.achievement_id WHERE s.status='active'
  UNION ALL
  SELECT 'mission',ms.created_at,s.name,'Выполнена экологическая миссия',
   m.title_ru,'/missions'
  FROM mission_submissions ms JOIN schools s ON s.id=ms.school_id
  JOIN eco_missions m ON m.id=ms.mission_id
  WHERE ms.status='approved' AND s.status='active'
  UNION ALL
  SELECT 'news',n.created_at,COALESCE(s.name,'ЭКОРАЙОН'),n.title,
   COALESCE(n.category,'Новости'),'/news/'||n.id::text
  FROM news n LEFT JOIN schools s ON s.id=n.school_id WHERE n.status='published'
 ) events ORDER BY happened_at DESC NULLS LAST LIMIT $1`,[limit]);
 return r.rows;
}

app.get('/pulse',async(req,res,next)=>{try{
 const events=await loadPulseEvents(60);
 const stats=await query(`SELECT
  (SELECT COUNT(*)::int FROM schools WHERE status='active') schools,
  (SELECT COUNT(*)::int FROM collection_entries WHERE status='approved') collections,
  (SELECT COALESCE(SUM(quantity),0)::numeric(14,2) FROM collection_entries WHERE status='approved') kilograms,
  (SELECT COUNT(*)::int FROM mission_submissions WHERE status='approved') missions`);
 const kind=['all','collection','mission','achievement','news'].includes(req.query.type)?req.query.type:'all';
 const filtered=kind==='all'?events:events.filter(e=>e.kind===kind);
 res.render('pulse',{title:req.session.lang==='by'?'Пульс ЭКАРАЁНА':'Пульс ЭКОРАЙОНА',events:filtered,stats:stats.rows[0],activeType:kind});
}catch(e){next(e)}});

app.get('/news-list',async(req,res,next)=>{try{const r=await query("SELECT n.*,s.name school_name FROM news n LEFT JOIN schools s ON s.id=n.school_id WHERE n.status='published' ORDER BY n.created_at DESC");res.render('news-list',{title:'Новости и мероприятия',items:r.rows});}catch(e){next(e)}});

app.get('/missions',async(req,res,next)=>{try{
 const sid=req.session.user?.role==='school'?req.session.user.school_id:null;
 const r=await query(`SELECT m.*,ms.status submission_status FROM eco_missions m LEFT JOIN mission_submissions ms ON ms.mission_id=m.id AND ms.school_id=$1 WHERE m.active=true AND m.starts_on<=CURRENT_DATE AND (m.ends_on IS NULL OR m.ends_on>=CURRENT_DATE) ORDER BY m.ends_on NULLS LAST,m.created_at DESC`,[sid]);
 const all=req.session.user&&['admin','staff'].includes(req.session.user.role)?await query('SELECT ms.*,m.title_ru,s.name school_name FROM mission_submissions ms JOIN eco_missions m ON m.id=ms.mission_id JOIN schools s ON s.id=ms.school_id ORDER BY ms.created_at DESC LIMIT 50'): {rows:[]};
 res.render('missions',{title:req.session.lang==='by'?'Эказаданні':'Экозадания',missions:r.rows,submissions:all.rows,adminMode:false});
 }catch(e){next(e)}});
app.post('/missions/:id/join',requireSchool,async(req,res,next)=>{try{
 const m=await query('SELECT id FROM eco_missions WHERE id=$1 AND active=true AND starts_on<=CURRENT_DATE AND (ends_on IS NULL OR ends_on>=CURRENT_DATE)',[req.params.id]);
 if(!m.rowCount)return redirectMsg(res,'/missions','Задание уже недоступно.');
 await query('INSERT INTO mission_submissions(mission_id,school_id,note) VALUES($1,$2,$3) ON CONFLICT(mission_id,school_id) DO UPDATE SET note=EXCLUDED.note,status=$4,reviewed_by=NULL,created_at=NOW() WHERE mission_submissions.status=$5',[req.params.id,req.session.user.school_id,(req.body.note||'').trim()||null,'pending','rejected']);
 res.redirect('/missions?message='+encodeURIComponent('Участие отправлено администрации на проверку.'));
 }catch(e){next(e)}});
app.get('/admin/missions',requireAdmin,async(req,res,next)=>{try{
 const [missions,submissions]=await Promise.all([query('SELECT * FROM eco_missions ORDER BY created_at DESC'),query(`SELECT ms.*,m.title_ru,s.name school_name FROM mission_submissions ms JOIN eco_missions m ON m.id=ms.mission_id JOIN schools s ON s.id=ms.school_id ORDER BY ms.created_at DESC LIMIT 100`)]);
 res.render('missions',{title:'Управление экозаданиями',missions:missions.rows,submissions:submissions.rows,adminMode:true});
 }catch(e){next(e)}});
app.post('/admin/missions',requireAdmin,async(req,res,next)=>{try{
 const {title_ru,title_by,description_ru,description_by,points,starts_on,ends_on}=req.body;
 const p=Number(points);
 if(!title_ru||!title_by||!description_ru||!description_by||!Number.isInteger(p)||p<0||p>10000)return redirectMsg(res,'/admin/missions','Заполните названия и описания на двух языках, баллы укажите от 0 до 10000.');
 await query('INSERT INTO eco_missions(title_ru,title_by,description_ru,description_by,points,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[title_ru,title_by,description_ru,description_by,p,starts_on||new Date().toISOString().slice(0,10),ends_on||null,req.session.user.id]);
 res.redirect('/admin/missions?message='+encodeURIComponent('Экозадание опубликовано.'));
 }catch(e){next(e)}});
app.post('/admin/missions/:id/review',requireAdmin,async(req,res,next)=>{try{
 const status=req.body.status;
 if(!['approved','rejected'].includes(status))return redirectMsg(res,'/admin/missions','Недопустимый статус.');
 const r=await query("UPDATE mission_submissions SET status=$1,reviewed_by=$2 WHERE id=$3 AND status='pending' RETURNING mission_id,school_id",[status,req.session.user.id,req.params.id]);
 if(r.rowCount&&status==='approved'){
  const m=await query('SELECT title_ru,points FROM eco_missions WHERE id=$1',[r.rows[0].mission_id]);
  if(m.rowCount&&Number(m.rows[0].points)>0)await query("INSERT INTO point_ledger(school_id,kind,points,reason,created_by) VALUES($1,'event',$2,$3,$4)",[r.rows[0].school_id,m.rows[0].points,'Выполнение экозадания: '+m.rows[0].title_ru,req.session.user.id]);
  await notify({schoolId:r.rows[0].school_id,title:'Экозадание проверено',body:'Участие подтверждено. Дополнительные баллы начислены.'}); await awardEligibleAchievements(r.rows[0].school_id);
 }
 res.redirect('/admin/missions?message='+encodeURIComponent('Результат проверки сохранён.'));
 }catch(e){next(e)}});
app.post('/admin/missions/:id/status',requireAdmin,async(req,res,next)=>{try{await query('UPDATE eco_missions SET active=$1 WHERE id=$2',[req.body.active==='true',req.params.id]);res.redirect('/admin/missions');}catch(e){next(e)}});
app.get('/achievements',async(req,res,next)=>{try{
 const r=await query(`SELECT a.*,COUNT(sa.id)::int earned_count FROM eco_achievements a LEFT JOIN school_achievements sa ON sa.achievement_id=a.id GROUP BY a.id ORDER BY a.threshold_kg`);
 const earned=await query(`SELECT sa.earned_at,a.title_ru,a.title_by,a.icon,s.name school_name FROM school_achievements sa JOIN eco_achievements a ON a.id=sa.achievement_id JOIN schools s ON s.id=sa.school_id ORDER BY sa.earned_at DESC LIMIT 60`);
 res.render('achievements',{title:req.session.lang==='by'?'Дасягненні':'Достижения',items:r.rows,earned:earned.rows});
 }catch(e){next(e)}});
app.get('/hall-of-fame',async(req,res,next)=>{try{
 const r=await query(`SELECT s.id,s.name,
 (SELECT COUNT(*)::int FROM school_achievements sa WHERE sa.school_id=s.id) badges,
 (SELECT COALESCE(SUM(l.points),0)::numeric(14,2) FROM point_ledger l WHERE l.school_id=s.id) points,
 (SELECT COALESCE(SUM(e.quantity),0)::numeric(14,2) FROM collection_entries e WHERE e.school_id=s.id AND e.status='approved') kg
 FROM schools s WHERE s.status='active'
 ORDER BY badges DESC,points DESC,kg DESC LIMIT 30`);
 res.render('hall-of-fame',{title:req.session.lang==='by'?'Зала славы':'Зал славы',schools:r.rows});
 }catch(e){next(e)}});
app.get('/impact',async(req,res,next)=>{try{
 const [totals,materials,events]=await Promise.all([
 query(`SELECT COALESCE(SUM(quantity),0)::numeric(14,2) kg,COUNT(DISTINCT school_id)::int schools,COUNT(*)::int entries FROM collection_entries WHERE status='approved'`),
 query(`SELECT m.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM materials m LEFT JOIN collection_entries e ON e.material_code=m.code AND e.status='approved' GROUP BY m.code,m.name ORDER BY total DESC`),
 query("SELECT COUNT(*)::int count FROM mission_submissions WHERE status='approved'")]);
 res.render('impact',{title:req.session.lang==='by'?'Экалагічны вынік':'Экологический результат',totals:totals.rows[0],materials:materials.rows,events:events.rows[0]});
 }catch(e){next(e)}});
app.get('/seasons',async(req,res,next)=>{try{
 const [month,year]=await Promise.all([
 query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status='approved' AND date_trunc('month',e.period_month)=date_trunc('month',CURRENT_DATE) WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 20`),
 query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status='approved' AND date_trunc('year',e.period_month)=date_trunc('year',CURRENT_DATE) WHERE s.status='active' GROUP BY s.id ORDER BY total DESC LIMIT 20`)]);
 res.render('seasons',{title:req.session.lang==='by'?'Экасезоны':'Экосезоны',month:month.rows,year:year.rows});
 }catch(e){next(e)}});

app.get('/world',async(req,res,next)=>{try{
 const [totals,leaders]=await Promise.all([
 query(`SELECT COALESCE(SUM(quantity),0)::numeric(14,2) kg,COUNT(DISTINCT school_id)::int schools FROM collection_entries WHERE status='approved'`),
 query(`SELECT s.id,s.name,s.avatar_code,COALESCE(SUM(e.quantity),0)::numeric(14,2) kg FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status='approved' WHERE s.status='active' GROUP BY s.id ORDER BY kg DESC LIMIT 8`)]);
 const stages=[
  {kg:0,name:'Пробуждение планеты',nameBy:'Абуджэнне планеты',icon:'🌍',desc:'Первый росток новой экологической истории','descBy':'Першы парастак новай экалагічнай гісторыі'},
  {kg:100,name:'Зелёные долины',nameBy:'Зялёныя даліны',icon:'🌱',desc:'Появляются первые леса и зелёные зоны','descBy':'З’яўляюцца першыя лясы і зялёныя зоны'},
  {kg:500,name:'Лес живых историй',nameBy:'Лес жывых гісторый',icon:'🌳',desc:'Растут леса, возвращаются лесные жители','descBy':'Растуць лясы, вяртаюцца лясныя жыхары'},
  {kg:1000,name:'Город чистой энергии',nameBy:'Горад чыстай энергіі',icon:'🏙️',desc:'Открываются экостанции и чистые улицы','descBy':'Адкрываюцца экастанцыі і чыстыя вуліцы'},
  {kg:2500,name:'Океан жизни',nameBy:'Акіян жыцця',icon:'🐬',desc:'Восстанавливаются водные пространства','descBy':'Аднаўляюцца водныя прасторы'},
  {kg:5000,name:'Заповедник будущего',nameBy:'Запаведнік будучыні',icon:'🦋',desc:'Появляется большой природный заповедник','descBy':'З’яўляецца вялікі прыродны запаведнік'},
  {kg:10000,name:'Экополис будущего',nameBy:'Экапаліс будучыні',icon:'✨',desc:'Район достигает легендарного экологического уровня','descBy':'Раён дасягае легендарнага экалагічнага ўзроўню'}
 ];
 const kg=Number(totals.rows[0].kg||0);
 let stageIndex=0;for(let i=0;i<stages.length;i++)if(kg>=stages[i].kg)stageIndex=i;
 const current=stages[stageIndex],next=stages[stageIndex+1]||null;
 const progress=next?Math.max(0,Math.min(100,(kg-current.kg)/(next.kg-current.kg)*100)):100;
 res.render('world',{title:req.session.lang==='by'?'Віртуальны свет':'Виртуальный мир',totals:totals.rows[0],leaders:leaders.rows,stages,current,next,progress});
 }catch(e){next(e)}});
app.get('/battles',async(req,res,next)=>{try{
 const [rank,month]=await Promise.all([
 query(`SELECT s.id,s.name,s.avatar_code,
  COALESCE(SUM(e.quantity),0)::numeric(14,2) kg,
  (SELECT COALESCE(SUM(p.points),0)::numeric(14,2) FROM point_ledger p WHERE p.school_id=s.id) points,
  (SELECT COUNT(*)::int FROM school_achievements a WHERE a.school_id=s.id) badges
  FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status='approved' AND date_trunc('month',e.period_month)=date_trunc('month',CURRENT_DATE)
  WHERE s.status='active' GROUP BY s.id ORDER BY kg DESC,points DESC LIMIT 30`),
 query("SELECT to_char(CURRENT_DATE,'TMMonth YYYY') label")]);
 res.render('battles',{title:req.session.lang==='by'?'Экабатлы':'Эко-баттлы',schools:rank.rows,monthLabel:month.rows[0].label});
 }catch(e){next(e)}});
app.post('/school/avatar',requireSchool,async(req,res,next)=>{try{
 const code=String(req.body.avatar_code||'');
 const option=SCHOOL_AVATARS.find(x=>x.code===code);
 if(!option)return redirectMsg(res,'/school-panel','Неизвестный персонаж команды.');
 const p=await query('SELECT COALESCE(SUM(points),0) total FROM point_ledger WHERE school_id=$1',[req.session.user.school_id]);
 if(Number(p.rows[0].total)<option.points)return redirectMsg(res,'/school-panel','Этот персонаж пока закрыт. Наберите больше баллов!');
 await query('UPDATE schools SET avatar_code=$1 WHERE id=$2',[code,req.session.user.school_id]);
 res.redirect('/school-panel?message='+encodeURIComponent('Персонаж команды обновлён!'));
 }catch(e){next(e)}});
app.get('/news/:id',async(req,res,next)=>{try{const r=await query(`SELECT n.*,s.name school_name FROM news n LEFT JOIN schools s ON s.id=n.school_id WHERE n.id=$1 AND n.status='published'`,[req.params.id]);if(!r.rowCount)return res.status(404).render('error',{title:'Не найдено',message:'Материал не найден.'});res.render('news-detail',{title:r.rows[0].title,item:r.rows[0]});}catch(e){next(e)}});

// Login, registration request, feedback
app.get('/login',(req,res)=>res.render('login',{title:'Вход'}));
app.post('/login',loginLimiter,async(req,res,next)=>{try{const {email,password}=req.body;const r=await query('SELECT u.*,s.name school_name FROM users u LEFT JOIN schools s ON s.id=u.school_id WHERE lower(email)=lower($1)',[email||'']);const u=r.rows[0];if(!u||!u.active||!(await bcrypt.compare(password||'',u.password_hash)))return res.status(401).render('login',{title:'Вход',error:'Неверный логин или пароль.'});req.session.user={id:u.id,name:u.name,email:u.email,role:u.role,school_id:u.school_id,school_name:u.school_name};await audit(u,'login');res.redirect('/dashboard');}catch(e){next(e)}});
app.post('/logout',requireAuth,async(req,res)=>{await audit(req.session.user,'logout');req.session.destroy(()=>res.redirect('/'));});
app.get('/register-school',(req,res)=>{const x=2+Math.floor(Math.random()*8),y=1+Math.floor(Math.random()*8);req.session.captchaAnswer=x+y;res.locals.captchaQuestion=`Сколько будет ${x} + ${y}?`;res.render('register',{title:'Заявка на регистрацию школы'});});
app.post('/register-school',loginLimiter,async(req,res,next)=>{try{const {name,address,locality,director,contact,answer}=req.body;if(!name||!contact||!(await verifyCaptcha(req)))return res.status(400).render('register',{title:'Заявка на регистрацию школы',error:'Заполните обязательные поля и правильно ответьте на проверочный вопрос.'});req.session.captchaAnswer=null;await query(`INSERT INTO feedback(name,contact,subject,message) VALUES($1,$2,'Заявка на регистрацию школы',$3)`,[director||name,contact,`Школа: ${name}\nАдрес: ${address||''}\nНаселённый пункт: ${locality||''}\nДиректор: ${director||''}`]);res.render('register',{title:'Заявка отправлена',success:'Заявка отправлена администрации. После проверки с вами свяжутся.'});}catch(e){next(e)}});
app.get('/feedback',(req,res)=>{const x=2+Math.floor(Math.random()*8),y=1+Math.floor(Math.random()*8);req.session.captchaAnswer=x+y;res.locals.captchaQuestion=`Сколько будет ${x} + ${y}?`;res.render('feedback',{title:'Обратная связь'});});
app.post('/feedback',loginLimiter,async(req,res,next)=>{try{const {name,contact,subject,message,answer}=req.body;const a=Number(req.session.captchaAnswer);if(!name||!contact||!subject||!message||!(await verifyCaptcha(req)))return res.status(400).render('feedback',{title:'Обратная связь',error:'Проверьте заполнение полей и ответ на проверочный вопрос.'});await query('INSERT INTO feedback(name,contact,subject,message) VALUES($1,$2,$3,$4)',[name,contact,subject,message]);req.session.captchaAnswer=null;res.render('feedback',{title:'Обратная связь',success:'Сообщение отправлено администрации.'});}catch(e){next(e)}});

// Dashboard
app.get('/dashboard',requireAuth,async(req,res,next)=>{try{const u=req.session.user;if(u.role==='school')return res.redirect('/school-panel');if(!['admin','staff'].includes(u.role))return res.redirect('/');const [counts,entries,requests,feedback,tickets]=await Promise.all([query(`SELECT (SELECT COUNT(*) FROM schools WHERE status='active') schools,(SELECT COUNT(*) FROM collection_entries WHERE status='pending') pending,(SELECT COUNT(*) FROM feedback WHERE status='new') feedback,(SELECT COUNT(*) FROM support_tickets WHERE status='new') tickets`),query(`SELECT e.*,s.name school_name,m.name material_name,c.name class_name FROM collection_entries e JOIN schools s ON s.id=e.school_id JOIN materials m ON m.code=e.material_code LEFT JOIN classes c ON c.id=e.class_id ORDER BY e.created_at DESC LIMIT 12`),query(`SELECT cr.*,s.name school_name FROM class_requests cr JOIN schools s ON s.id=cr.school_id WHERE cr.status='pending' ORDER BY cr.created_at DESC LIMIT 8`),query(`SELECT * FROM feedback ORDER BY created_at DESC LIMIT 8`),query(`SELECT t.*,s.name school_name FROM support_tickets t JOIN schools s ON s.id=t.school_id ORDER BY t.created_at DESC LIMIT 8`)]);res.render('admin-dashboard',{title:'Панель администрации',counts:counts.rows[0],entries:entries.rows,requests:requests.rows,feedback:feedback.rows,tickets:tickets.rows});}catch(e){next(e)}});
app.get('/school-panel',requireSchool,async(req,res,next)=>{try{const sid=req.session.user.school_id;const [school,classes,entries,notifs,tickets,points,pointHistory,certificates,badges,avatarPoints]=await Promise.all([query('SELECT * FROM schools WHERE id=$1',[sid]),query('SELECT * FROM classes WHERE school_id=$1 AND active=true ORDER BY name',[sid]),query(`SELECT e.*,m.name material_name,c.name class_name FROM collection_entries e JOIN materials m ON m.code=e.material_code LEFT JOIN classes c ON c.id=e.class_id WHERE e.school_id=$1 ORDER BY e.created_at DESC LIMIT 20`,[sid]),query('SELECT * FROM notifications WHERE school_id=$1 ORDER BY created_at DESC LIMIT 8',[sid]),query('SELECT * FROM support_tickets WHERE school_id=$1 ORDER BY created_at DESC LIMIT 5',[sid]),query('SELECT COALESCE(SUM(points),0)::numeric(14,2) total FROM point_ledger WHERE school_id=$1',[sid]),query('SELECT kind,points,reason,created_at FROM point_ledger WHERE school_id=$1 ORDER BY created_at DESC LIMIT 10',[sid]),query('SELECT * FROM certificates WHERE school_id=$1 ORDER BY created_at DESC LIMIT 30',[sid]),query('SELECT a.* FROM school_achievements sa JOIN eco_achievements a ON a.id=sa.achievement_id WHERE sa.school_id=$1 ORDER BY sa.earned_at DESC',[sid]),query('SELECT COALESCE(SUM(points),0) total FROM point_ledger WHERE school_id=$1',[sid])]);res.render('school-dashboard',{title:'Кабинет школы',school:school.rows[0],classes:classes.rows,entries:entries.rows,notifications:notifs.rows,tickets:tickets.rows,points:points.rows[0].total,pointHistory:pointHistory.rows,certificates:certificates.rows,badges:badges.rows,avatarOptions:SCHOOL_AVATARS.filter(a=>Number(avatarPoints.rows[0].total)>=a.points),avatarPoints:Number(avatarPoints.rows[0].total)});}catch(e){next(e)}});
// School collection data
app.get('/entries/new',requireSchool,async(req,res,next)=>{try{const c=await query('SELECT * FROM classes WHERE school_id=$1 AND active=true ORDER BY name',[req.session.user.school_id]);const m=await query('SELECT * FROM materials ORDER BY name');res.render('entry-form',{title:'Новая запись',classes:c.rows,materials:m.rows});}catch(e){next(e)}});
app.post('/entries',requireSchool,async(req,res,next)=>{try{const {class_id,material_code,quantity,period_month,note,certificate_type,student_name}=req.body;const q=Number(quantity);const certType=['auto','school','class','student'].includes(certificate_type)?certificate_type:'auto';const student=(student_name||'').trim();if(!material_code||!Number.isFinite(q)||q<=0) return redirectMsg(res,'/entries/new','Укажите вид вторсырья и положительное количество.');const cls=class_id?await query('SELECT id FROM classes WHERE id=$1 AND school_id=$2 AND active=true',[class_id,req.session.user.school_id]):{rowCount:1};if(!cls.rowCount)return redirectMsg(res,'/entries/new','Выбранный класс не найден.');if((certType==='class'||certType==='student')&&!class_id)return redirectMsg(res,'/entries/new','Для грамоты классу или ученику выберите класс.');if(certType==='student'&&!student)return redirectMsg(res,'/entries/new','Укажите имя ученика для персональной грамоты.');const r=await query(`INSERT INTO collection_entries(school_id,class_id,material_code,quantity,period_month,note,created_by,certificate_type,student_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[req.session.user.school_id,class_id||null,material_code,q,monthStart(period_month),note||null,req.session.user.id,certType,student||null]);await query(`INSERT INTO entry_history(entry_id,action,details,actor_id) VALUES($1,'created',$2,$3)`,[r.rows[0].id,JSON.stringify({quantity:q,material_code,certificate_type:certType,student_name:student||null}),req.session.user.id]);await notify({schoolId:req.session.user.school_id,title:'Новая запись отправлена',body:'Запись добавлена в предварительную статистику и ожидает проверки.'});await audit(req.session.user,'create_entry','collection_entries',r.rows[0].id);res.redirect('/school-panel?message='+encodeURIComponent('Запись добавлена и ожидает проверки. После подтверждения грамота появится в кабинете.'));}catch(e){next(e)}});
app.post('/entries/:id/resubmit',requireSchool,async(req,res,next)=>{try{const {quantity,note}=req.body;const q=Number(quantity);if(!Number.isFinite(q)||q<=0)return redirectMsg(res,'/school-panel','Количество должно быть больше нуля.');const r=await query(`UPDATE collection_entries SET quantity=$1,note=$2,status='pending',review_comment=NULL,updated_at=NOW() WHERE id=$3 AND school_id=$4 AND status='correction' RETURNING id`,[q,note||null,req.params.id,req.session.user.school_id]);if(!r.rowCount)return redirectMsg(res,'/school-panel','Запись не найдена или не требует исправления.');await query(`INSERT INTO entry_history(entry_id,action,details,actor_id) VALUES($1,'resubmitted',$2,$3)`,[r.rows[0].id,JSON.stringify({quantity:q,note}),req.session.user.id]);await notify({schoolId:req.session.user.school_id,title:'Запись отправлена повторно',body:'Исправленная запись снова ожидает проверки.'});res.redirect('/school-panel?message='+encodeURIComponent('Исправленная запись отправлена.'));}catch(e){next(e)}});
app.post('/school/classes/request',requireSchool,async(req,res,next)=>{try{const {action,class_name}=req.body;if(!class_name||!['add','remove'].includes(action))return redirectMsg(res,'/school-panel','Заполните название класса.');await query('INSERT INTO class_requests(school_id,action,class_name) VALUES($1,$2,$3)',[req.session.user.school_id,action,class_name]);await notify({schoolId:req.session.user.school_id,title:'Запрос по классу отправлен',body:'Администрация рассмотрит ваш запрос.'});res.redirect('/school-panel?message='+encodeURIComponent('Запрос отправлен администрации.'));}catch(e){next(e)}});
app.post('/school/students',requireSchool,async(req,res,next)=>{try{const count=Math.max(0,parseInt(req.body.students,10));if(!Number.isInteger(count))return redirectMsg(res,'/school-panel','Введите корректное число учащихся.');const old=await query('SELECT students FROM schools WHERE id=$1',[req.session.user.school_id]);await query('INSERT INTO student_history(school_id,old_count,new_count,changed_by) VALUES($1,$2,$3,$4)',[req.session.user.school_id,old.rows[0].students,count,req.session.user.id]);await query('UPDATE schools SET students=$1 WHERE id=$2',[count,req.session.user.school_id]);res.redirect('/school-panel?message='+encodeURIComponent('Численность обновлена.'));}catch(e){next(e)}});
app.post('/school/classes/:id/students',requireSchool,async(req,res,next)=>{try{const count=Math.max(0,parseInt(req.body.students,10));const r=await query('SELECT students FROM classes WHERE id=$1 AND school_id=$2',[req.params.id,req.session.user.school_id]);if(!r.rowCount||!Number.isInteger(count))return redirectMsg(res,'/school-panel','Не удалось изменить численность класса.');await query('INSERT INTO student_history(school_id,class_id,old_count,new_count,changed_by) VALUES($1,$2,$3,$4,$5)',[req.session.user.school_id,req.params.id,r.rows[0].students,count,req.session.user.id]);await query('UPDATE classes SET students=$1 WHERE id=$2',[count,req.params.id]);res.redirect('/school-panel?message='+encodeURIComponent('Численность класса обновлена.'));}catch(e){next(e)}});
app.post('/school/support',requireSchool,async(req,res,next)=>{try{await query('INSERT INTO support_tickets(school_id,user_id,subject,message) VALUES($1,$2,$3,$4)',[req.session.user.school_id,req.session.user.id,req.body.subject,req.body.message]);res.redirect('/school-panel?message='+encodeURIComponent('Обращение в поддержку отправлено.'));}catch(e){next(e)}});

// Admin review and management
app.post('/admin/entries/:id/review',requireAdmin,async(req,res,next)=>{try{const {status,review_comment}=req.body;if(!['approved','correction'].includes(status))return redirectMsg(res,'/dashboard','Недопустимый статус.');const r=await query('UPDATE collection_entries SET status=$1,review_comment=$2,reviewed_by=$3,updated_at=NOW() WHERE id=$4 RETURNING school_id,material_code,quantity',[status,review_comment||null,req.session.user.id,req.params.id]);if(!r.rowCount)return redirectMsg(res,'/dashboard','Запись не найдена.');if(status==='approved'){await query(`INSERT INTO point_ledger(school_id,entry_id,kind,points,rate_snapshot,reason,created_by) SELECT $1,$2,'collection',ROUND($3::numeric*pr.points_per_kg,2),pr.points_per_kg,'Начисление за подтверждённую сдачу: '||m.name,$4 FROM point_rates pr JOIN materials m ON m.code=pr.material_code WHERE pr.material_code=$5 ON CONFLICT(entry_id) DO NOTHING`,[r.rows[0].school_id,req.params.id,r.rows[0].quantity,req.session.user.id,r.rows[0].material_code]);const cert=await query(`INSERT INTO certificates(entry_id,school_id,certificate_type,recipient_name,school_name,class_name,material_name,quantity,unit,period_month) SELECT e.id,e.school_id,CASE WHEN e.certificate_type='auto' THEN CASE WHEN e.class_id IS NULL THEN 'school' ELSE 'class' END ELSE e.certificate_type END,CASE WHEN e.certificate_type='student' THEN e.student_name WHEN e.certificate_type='class' THEN COALESCE(c.name,'Класс') ELSE s.name END,s.name,c.name,m.name,e.quantity,m.unit,e.period_month FROM collection_entries e JOIN schools s ON s.id=e.school_id JOIN materials m ON m.code=e.material_code LEFT JOIN classes c ON c.id=e.class_id WHERE e.id=$1 AND e.status='approved' AND (e.certificate_type<>'student' OR NULLIF(BTRIM(e.student_name),'') IS NOT NULL) ON CONFLICT(entry_id) DO NOTHING RETURNING id,created_at`,[req.params.id]);if(cert.rowCount){const serial='ЭР-'+new Date(cert.rows[0].created_at).getFullYear()+'-'+String(cert.rows[0].id).padStart(6,'0');await query('UPDATE certificates SET serial_number=$1 WHERE id=$2',[serial,cert.rows[0].id]);}}
if(status==='approved') await awardEligibleAchievements(r.rows[0].school_id);
await query(`INSERT INTO entry_history(entry_id,action,details,actor_id) VALUES($1,$2,$3,$4)`,[req.params.id,status,JSON.stringify({review_comment}),req.session.user.id]);await notify({schoolId:r.rows[0].school_id,title:status==='approved'?'Запись подтверждена':'Требуется исправление',body:review_comment||(status==='approved'?'Администрация подтвердила запись. Баллы начислены, грамота сформирована и доступна в кабинете школы.':'Пожалуйста, исправьте запись и отправьте повторно.')});await audit(req.session.user,'review_entry','collection_entries',req.params.id,{status});res.redirect('/dashboard?message='+encodeURIComponent('Статус записи обновлён.'));}catch(e){next(e)}});
app.get('/admin/schools',requireAdmin,async(req,res,next)=>{try{const r=await query(`SELECT s.*,COUNT(DISTINCT u.id)::int users_count FROM schools s LEFT JOIN users u ON u.school_id=s.id GROUP BY s.id ORDER BY s.name`);res.render('admin-schools',{title:'Управление школами',schools:r.rows});}catch(e){next(e)}});
app.get('/admin/schools/new',requireAdmin,(req,res)=>res.render('school-form',{title:'Добавить школу'}));
app.post('/admin/schools',requireAdmin,async(req,res,next)=>{try{const {name,address,locality,director,contact,students}=req.body;if(!name)return redirectMsg(res,'/admin/schools/new','Название обязательно.');const r=await query(`INSERT INTO schools(name,address,locality,director,contact,students) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[name,address||null,locality||null,director||null,contact||null,Math.max(0,Number(students)||0)]);await audit(req.session.user,'create_school','schools',r.rows[0].id);res.redirect('/admin/schools?message='+encodeURIComponent('Школа добавлена. Создайте для неё учётную запись.'));}catch(e){next(e)}});
app.post('/admin/schools/:id/status',requireMainAdmin,async(req,res,next)=>{try{const status=req.body.status;if(!['active','paused','archived'].includes(status))return redirectMsg(res,'/admin/schools','Недопустимый статус.');await query('UPDATE schools SET status=$1 WHERE id=$2',[status,req.params.id]);await audit(req.session.user,'change_school_status','schools',req.params.id,{status});res.redirect('/admin/schools?message='+encodeURIComponent('Статус школы обновлён.'));}catch(e){next(e)}});
app.post('/admin/schools/:id/delete',requireMainAdmin,async(req,res,next)=>{try{if(req.body.confirm!=='DELETE')return redirectMsg(res,'/admin/schools','Для удаления требуется подтверждение.');await query('DELETE FROM schools WHERE id=$1',[req.params.id]);await audit(req.session.user,'delete_school','schools',req.params.id);res.redirect('/admin/schools?message='+encodeURIComponent('Школа и связанные данные удалены.'));}catch(e){next(e)}});
app.get('/admin/users/new',requireMainAdmin,async(req,res,next)=>{try{const s=await query("SELECT id,name FROM schools WHERE status='active' ORDER BY name");res.render('user-form',{title:'Создать аккаунт школы',schools:s.rows});}catch(e){next(e)}});
app.post('/admin/users',requireMainAdmin,async(req,res,next)=>{try{const {name,email,password,school_id}=req.body;if(!name||!email||!password||password.length<10)return redirectMsg(res,'/admin/users/new','Заполните поля. Пароль — минимум 10 символов.');const hash=await bcrypt.hash(password,12);await query("INSERT INTO users(name,email,password_hash,role,school_id) VALUES($1,$2,$3,'school',$4)",[name,email,hash,school_id]);res.redirect('/admin/schools?message='+encodeURIComponent('Аккаунт школы создан. Передайте временный пароль ответственному безопасным способом.'));}catch(e){next(e)}});
app.get('/admin/class-requests',requireAdmin,async(req,res,next)=>{try{const r=await query('SELECT cr.*,s.name school_name FROM class_requests cr JOIN schools s ON s.id=cr.school_id ORDER BY cr.created_at DESC');res.render('class-requests',{title:'Запросы классов',requests:r.rows});}catch(e){next(e)}});
app.post('/admin/class-requests/:id',requireAdmin,async(req,res,next)=>{try{const status=req.body.status;const r=await query('UPDATE class_requests SET status=$1,reviewed_by=$2 WHERE id=$3 AND status=\'pending\' RETURNING *',[status,req.session.user.id,req.params.id]);if(r.rowCount&&status==='approved'){const x=r.rows[0];if(x.action==='add')await query('INSERT INTO classes(school_id,name) VALUES($1,$2) ON CONFLICT(school_id,name) DO UPDATE SET active=true',[x.school_id,x.class_name]);else await query('UPDATE classes SET active=false WHERE school_id=$1 AND name=$2',[x.school_id,x.class_name]);}res.redirect('/admin/class-requests');}catch(e){next(e)}});
app.get('/admin/news',requireAdmin,async(req,res,next)=>{try{const r=await query('SELECT n.*,s.name school_name FROM news n LEFT JOIN schools s ON s.id=n.school_id ORDER BY n.created_at DESC');res.render('admin-news',{title:'Новости и мероприятия',items:r.rows});}catch(e){next(e)}});
app.post('/admin/news',requireAdmin,async(req,res,next)=>{try{await query("INSERT INTO news(title,body,category,status,created_by,event_date) VALUES($1,$2,$3,'published',$4,$5)",[req.body.title,req.body.body,req.body.category||'news',req.session.user.id,req.body.event_date||null]);res.redirect('/admin/news?message='+encodeURIComponent('Материал опубликован.'));}catch(e){next(e)}});
app.post('/admin/news/:id/status',requireAdmin,async(req,res,next)=>{try{await query('UPDATE news SET status=$1 WHERE id=$2',[req.body.status,req.params.id]);res.redirect('/admin/news');}catch(e){next(e)}});
app.get('/admin/inbox',requireAdmin,async(req,res,next)=>{try{const [f,t]=await Promise.all([query('SELECT * FROM feedback ORDER BY created_at DESC'),query('SELECT t.*,s.name school_name FROM support_tickets t JOIN schools s ON s.id=t.school_id ORDER BY t.created_at DESC')]);res.render('inbox',{title:'Обращения',feedback:f.rows,tickets:t.rows});}catch(e){next(e)}});
app.post('/admin/feedback/:id/status',requireAdmin,async(req,res,next)=>{try{await query('UPDATE feedback SET status=$1 WHERE id=$2',[req.body.status,req.params.id]);res.redirect('/admin/inbox');}catch(e){next(e)}});
app.post('/admin/tickets/:id/reply',requireAdmin,async(req,res,next)=>{try{await query("UPDATE support_tickets SET admin_reply=$1,status='answered',updated_at=NOW() WHERE id=$2 RETURNING school_id",[req.body.reply,req.params.id]);const r=await query('SELECT school_id FROM support_tickets WHERE id=$1',[req.params.id]);if(r.rowCount)await notify({schoolId:r.rows[0].school_id,title:'Ответ технической поддержки',body:'На ваше обращение поступил ответ.'});res.redirect('/admin/inbox');}catch(e){next(e)}});
app.get('/notifications',requireAuth,async(req,res,next)=>{try{const u=req.session.user;const r=await query('SELECT * FROM notifications WHERE user_id=$1 OR (user_id IS NULL AND ($2::bigint IS NOT NULL AND school_id=$2)) ORDER BY created_at DESC LIMIT 100',[u.id,u.school_id]);await query('UPDATE notifications SET read_at=NOW() WHERE user_id=$1 OR (user_id IS NULL AND school_id=$2)',[u.id,u.school_id]);res.render('notifications',{title:'Уведомления',items:r.rows});}catch(e){next(e)}});

// Скачать грамоту: праздничный PDF в фирменном стиле ЭКОРАЙОН.
app.get('/certificates/:id/pdf',requireAuth,async(req,res,next)=>{
  try{
    const u=req.session.user;
    const params=[req.params.id];
    let sql='SELECT * FROM certificates WHERE id=$1';
    if(u.role==='school'){sql+=' AND school_id=$2';params.push(u.school_id);}
    const r=await query(sql,params);
    if(!r.rowCount)return res.status(404).render('error',{title:'Грамота не найдена',message:'Грамота не найдена или у вас нет доступа.'});
    const c=r.rows[0];
    const doc=new PDFDocument({size:'A4',layout:'landscape',margin:0,info:{Title:'Грамота ЭКОРАЙОН',Author:'ЭКОРАЙОН',Subject:'Награда за вклад в экологию'}});
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`inline; filename="ekorayon-certificate-${c.id}.pdf"`);
    res.setHeader('Cache-Control','private, no-store');
    doc.pipe(res);

    // Встраиваемый шрифт с поддержкой кириллицы — без подмены на Helvetica.
    const font=__dirname + '/../public/fonts/DejaVuSans.ttf';
    doc.registerFont('Eco',font);
    const W=doc.page.width,H=doc.page.height;
    const dark='#082F27',green='#087B58',mint='#B8F2D0',gold='#D6AD55',cream='#FFFDF4',ink='#173D32',muted='#55766B';

    // Глубокий природный фон и светлая наградная область.
    doc.rect(0,0,W,H).fill(dark);
    doc.save();
    doc.roundedRect(25,25,W-50,H-50,18).fill(cream);
    doc.restore();
    doc.roundedRect(25,25,W-50,H-50,18).lineWidth(5).stroke(gold);
    doc.roundedRect(36,36,W-72,H-72,13).lineWidth(1.5).stroke(green);

    // Декоративные листья по углам.
    function leaf(x,y,angle,color){
      doc.save();
      doc.translate(x,y);
      doc.rotate(angle);
      doc.ellipse(0,0,8,22).fill(color);
      doc.moveTo(0,-17).lineTo(0,17).lineWidth(1).stroke(dark);
      doc.restore();
    }
    [[63,66,-35,mint],[83,83,28,gold],[W-63,66,35,mint],[W-83,83,-28,gold],
     [63,H-66,35,gold],[83,H-83,-28,mint],[W-63,H-66,-35,gold],[W-83,H-83,28,mint]]
      .forEach(a=>leaf(...a));

    // Верхняя плашка бренда.
    doc.roundedRect(W/2-115,51,230,31,15).fill(dark);
    doc.font('Eco').fontSize(11).fillColor(mint).text('Э К О Р А Й О Н',W/2-105,61,{width:210,align:'center',characterSpacing:1.2});
    doc.font('Eco').fontSize(32).fillColor(green).text('ГРАМОТА',0,105,{width:W,align:'center',characterSpacing:3});
    doc.fontSize(11).fillColor(muted).text('НАГРАЖДАЕТСЯ',0,151,{width:W,align:'center',characterSpacing:2});

    // Имя получателя — главный акцент.
    doc.moveTo(155,183).lineTo(W-155,183).lineWidth(1.4).stroke(gold);
    const recipient=String(c.recipient_name||c.school_name||'Участник экологической акции');
    doc.font('Eco').fontSize(recipient.length>42?20:27).fillColor(dark).text(recipient,85,199,{width:W-170,align:'center',lineBreak:true});
    doc.moveTo(155,246).lineTo(W-155,246).lineWidth(1.4).stroke(gold);

    const reason=c.certificate_type==='student'
      ?'за личный вклад в сохранение природы и ответственное отношение к окружающей среде'
      :c.certificate_type==='class'
        ?'за активное участие в экологических инициативах и дружную командную работу'
        :'за значительный вклад в развитие экологической культуры и заботу о природе родного края';
    doc.font('Eco').fontSize(12).fillColor(ink).text(reason,105,263,{width:W-210,align:'center',lineGap:5});

    // Показатель достижения в отдельной наградной плашке.
    doc.roundedRect(W/2-185,319,370,76,13).fill(dark);
    doc.fontSize(10).fillColor(mint).text('СОБРАНО И ПЕРЕДАНО НА ПЕРЕРАБОТКУ',W/2-170,331,{width:340,align:'center',characterSpacing:.6});
    const amount=`${Number(c.quantity).toLocaleString('ru-RU',{maximumFractionDigits:2})} ${c.unit||''}`;
    doc.fontSize(25).fillColor('#F4D98C').text(amount,W/2-170,350,{width:340,align:'center'});

    const detail=[c.material_name,c.school_name,c.class_name].filter(Boolean).join('  •  ');
    doc.fontSize(10).fillColor(muted).text(detail,70,410,{width:W-140,align:'center'});
    const period=new Date(c.period_month);
    doc.fontSize(10).fillColor(muted).text(`Отчётный период: ${period.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})}`,70,432,{width:W-140,align:'center'});

    // Подписи и номер грамоты.
    const signY=H-105;
    doc.moveTo(105,signY).lineTo(285,signY).lineWidth(1).stroke(green);
    doc.moveTo(W-285,signY).lineTo(W-105,signY).stroke(green);
    doc.fontSize(9).fillColor(muted).text('Представитель школы',105,signY+8,{width:180,align:'center'});
    doc.text('ЭКОРАЙОН',W-285,signY+8,{width:180,align:'center'});
    doc.fontSize(8).fillColor(muted).text(`№ ${c.serial_number||('ЭР-'+c.id)}     •     ${new Date(c.created_at).toLocaleDateString('ru-RU')}`,0,H-48,{width:W,align:'center'});
    doc.end();
  }catch(e){next(e)}
});

// Reports: current totals, downloadable PDF and Excel exports
app.get('/reports',requireAuth,async(req,res,next)=>{try{const sid=req.session.user.role==='school'?req.session.user.school_id:null;const r=await query(`SELECT s.id,s.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM schools s LEFT JOIN collection_entries e ON e.school_id=s.id AND e.status IN ('pending','approved') WHERE ($1::bigint IS NULL OR s.id=$1) GROUP BY s.id ORDER BY s.name`,[sid]);res.render('reports',{title:'Отчёты',rows:r.rows});}catch(e){next(e)}});
app.get('/reports/pdf/:schoolId',requireAuth,async(req,res,next)=>{try{const sid=req.session.user.role==='school'?req.session.user.school_id:Number(req.params.schoolId);if(req.session.user.role==='school'&&sid!==req.session.user.school_id)return res.sendStatus(403);const s=await query('SELECT * FROM schools WHERE id=$1',[sid]);if(!s.rowCount)return res.sendStatus(404);const data=await query(`SELECT m.name,COALESCE(SUM(e.quantity),0)::numeric(14,2) total FROM materials m LEFT JOIN collection_entries e ON e.material_code=m.code AND e.school_id=$1 AND e.status='approved' GROUP BY m.code,m.name ORDER BY m.name`,[sid]);const doc=new PDFDocument({margin:50});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="otchet-shkoly-ekorayon-${sid}.pdf"`);doc.pipe(res);doc.font(__dirname + '/../public/fonts/DejaVuSans.ttf');doc.fontSize(18).text('ЭКОРАЙОН — ОТЧЁТ ШКОЛЫ',{align:'center'});doc.moveDown();doc.fontSize(12).text(`Школа: ${s.rows[0].name}`);doc.text(`Адрес: ${s.rows[0].address||'—'}`);doc.text(`Дата формирования: ${new Date().toLocaleDateString('ru-RU')}`);doc.moveDown().text('Подтверждённый сбор вторсырья (кг):');data.rows.forEach(x=>doc.text(`${x.name}: ${x.total} кг`));doc.moveDown().fontSize(11).text(`Директор: ${s.rows[0].director||'____________________'}`);doc.text('Ответственный: ____________________');doc.text('Подпись: ____________________      Печать: ____________________');doc.end();}catch(e){next(e)}});
app.get('/reports/excel',requireAuth,async(req,res,next)=>{try{const sid=req.session.user.role==='school'?req.session.user.school_id:null;const r=await query(`SELECT s.name school,c.name class,m.name material,e.quantity,e.period_month,e.status,e.created_at FROM collection_entries e JOIN schools s ON s.id=e.school_id JOIN materials m ON m.code=e.material_code LEFT JOIN classes c ON c.id=e.class_id WHERE ($1::bigint IS NULL OR s.id=$1) ORDER BY e.created_at DESC`,[sid]);const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Сбор вторсырья');ws.addRow(['Школа','Класс / общий сбор','Вторсырьё','Количество, кг','Период','Статус','Дата записи']);r.rows.forEach(x=>ws.addRow([x.school,x.class||'Общий сбор',x.material,Number(x.quantity),x.period_month,x.status,x.created_at]));ws.getRow(1).font={bold:true};ws.columns.forEach(c=>c.width=22);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="statistika-ekorayon.xlsx"');await wb.xlsx.write(res);res.end();}catch(e){next(e)}});
app.get('/admin/points',requireAdmin,async(req,res,next)=>{try{const [rates,schools,history]=await Promise.all([query(`SELECT m.code,m.name,COALESCE(r.points_per_kg,0) points_per_kg FROM materials m LEFT JOIN point_rates r ON r.material_code=m.code ORDER BY m.name`),query(`SELECT id,name FROM schools WHERE status='active' ORDER BY name`),query(`SELECT l.*,s.name school_name,u.name actor_name FROM point_ledger l JOIN schools s ON s.id=l.school_id LEFT JOIN users u ON u.id=l.created_by ORDER BY l.created_at DESC LIMIT 60`)]);res.render('admin-points',{title:'Баллы и тарифы',rates:rates.rows,schools:schools.rows,history:history.rows});}catch(e){next(e)}});
app.post('/admin/points/rates',requireMainAdmin,async(req,res,next)=>{try{for(const code of ['paper','plastic','glass','metal','batteries','electronics']){const value=Number(req.body['rate_'+code]);if(!Number.isFinite(value)||value<0||value>10000)return redirectMsg(res,'/admin/points','Тариф должен быть от 0 до 10000 баллов за кг.');await query(`INSERT INTO point_rates(material_code,points_per_kg,updated_by,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(material_code) DO UPDATE SET points_per_kg=EXCLUDED.points_per_kg,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[code,value,req.session.user.id]);}await audit(req.session.user,'update_point_rates','point_rates');res.redirect('/admin/points?message='+encodeURIComponent('Тарифы обновлены. Старые начисления не изменяются.'));}catch(e){next(e)}});
app.post('/admin/points/award',requireMainAdmin,async(req,res,next)=>{try{const schoolId=Number(req.body.school_id),points=Number(req.body.points),reason=String(req.body.reason||'').trim();if(!Number.isInteger(schoolId)||!Number.isFinite(points)||points===0||Math.abs(points)>100000||reason.length<4||reason.length>500)return redirectMsg(res,'/admin/points','Укажите школу, количество баллов и причину.');const s=await query(`SELECT id FROM schools WHERE id=$1 AND status='active'`,[schoolId]);if(!s.rowCount)return redirectMsg(res,'/admin/points','Школа не найдена.');await query(`INSERT INTO point_ledger(school_id,kind,points,reason,created_by) VALUES($1,'event',$2,$3,$4)`,[schoolId,points,reason,req.session.user.id]);await audit(req.session.user,'manual_points_award','point_ledger',schoolId,{points,reason});await notify({schoolId,title:'Изменение мотивационных баллов',body:'Администрация внесла изменение в ваш баланс. Подробности доступны в кабинете школы.'});res.redirect('/admin/points?message='+encodeURIComponent('Баллы добавлены в историю.'));}catch(e){next(e)}});
app.get('/admin/audit',requireMainAdmin,async(req,res,next)=>{try{const r=await query('SELECT a.*,u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200');res.render('audit',{title:'Журнал действий',items:r.rows});}catch(e){next(e)}});

app.get('/city-builder',(req,res)=>res.render('city-builder',{title:'Город будущего'}));
app.use((req,res)=>res.status(404).render('error',{title:'Страница не найдена',message:'Такой страницы нет. Проверьте адрес или вернитесь на главную.'}));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).render('error',{title:'Ошибка сервера',message:process.env.NODE_ENV==='production'?'Произошла ошибка. Попробуйте позже.':err.message});});
app.listen(PORT,()=>console.log(`ЭКОРАЙОН listening on ${PORT}`));
