<!-- The Bulgarian translation glossary for catalogue content (#5996). Every
     dictionary in src/data/content-i18n/bg/ follows it; a new translation reads
     it first. One English term, one Bulgarian term. -->

# Style rules for the Bulgarian catalogue headings (decided by the project lead; binding)

1. **Register.** Formal Bulgarian, the language of Bulgarian standards (БДС) and of the Bulgarian
   editions of EU legal acts. No colloquialisms, no machine-translation calques.
2. **Sentence case.** Capitalise the first word, proper nouns and acronyms only. English Title Case is
   NOT carried over: "Access Control Policy" -> "Политика за контрол на достъпа".
3. **Grammatical form follows the source.**
   - noun phrase -> noun phrase ("Asset inventory" -> "Опис на активите");
   - imperative ("Establish and maintain ...") -> polite imperative, 2nd person plural
     ("Създайте и поддържайте ..."), as in the task titles the product already ships
     ("Определете отговорника и обхвата на контрола", "Съберете доказателства за прилагането");
   - "-ing" headings ("Managing changes") -> verbal noun ("Управление на промените");
   - a question stays a question.
   Sibling headings of one list keep one parallel form.
4. **Codes, numbering and references stay exactly as in the source, in the same position**:
   "A.5.1", "CC6.1", "PR.AC-1", "V1.2", "ASI01", "Art. 21(2)(a)", "(L1)". Structural words are
   translated: Article -> Член, Annex -> Приложение, Clause -> Точка, Section -> Раздел,
   Chapter -> Глава, Recital -> Съображение. The separator the source uses (" - ", " — ", ":", "/")
   is kept as it is.
5. **Names that stay in Latin script**: standards, frameworks, products, vendors, protocols and
   technologies ("ISO/IEC 27001", "SOC 2", "NIST CSF", "OWASP ASVS", "CIS Controls", "Kubernetes",
   "OAuth", "TLS"). A heading that consists ONLY of such a name is returned byte-identical to the
   source. Everything else must contain Bulgarian text.
6. **Acronyms.** Use the form the glossary gives. As a rule: acronyms with an established Bulgarian
   form are translated (AI -> ИИ, ICT -> ИКТ, IT -> ИТ, EU -> ЕС); technical acronyms used in Latin
   in Bulgarian professional practice stay in Latin (API, MFA, SSO, VPN, SIEM, CI/CD, SBOM, DNS).
7. **Punctuation.** Do not add or remove a trailing period or colon. Bulgarian quotation marks
   „…“. "&" -> "и". "e.g." -> "напр.", "i.e." -> "т.е.", "etc." -> "и др.". Keep parentheses.
8. **`{placeholders}`** are copied unchanged.
9. **One input, one output string.** No notes, no alternatives, no explanations inside the text.
10. **Do not translate** file names, commands, HTTP headers, configuration keys or code.
11. **Consistency.** One English term has one Bulgarian term everywhere (see the glossary). Where the
    product's own Bulgarian interface already names a concept (control, risk, asset, evidence,
    policy, task, finding ...), the content uses the SAME word as the interface.
12. **Official wording.** Titles of articles, annexes and controls of EU legal acts (GDPR, NIS2, DORA,
    AI Act, the UAS regulations) and of ISO standards use the wording of the official Bulgarian
    edition where one exists.
13. **Concise.** These are headings shown in lists, menus and pickers. Do not expand them.

---

# Decisions of the project lead after the research (final; they override anything below that disagrees)

1. **Clause = „Точка“** in every heading ("Clause 4 Context of the organization" = „Точка 4 Контекст на организацията“). The interface's page name „Клаузи“ is aligned separately.
2. **CSIRT stays „CSIRT“** in Latin, as in the interface. Do not write „ЕРИКС“.
3. **Management-system acronyms.** ISMS = „СУСИ“ and QMS = „СУК“. **PIMS, AIMS and BCMS stay in Latin.**
4. **Article references.** "Article 21" = „Член 21“. An abbreviated reference inside a heading, "Art" or "Art.", becomes „чл.“ and its numbers stay as written: "(Art 24-27)" = „(чл. 24-27)“. A code that is the row's identifier (the `id` field of an item) is not part of the heading and is never translated.
5. **AI system = „система с ИИ“**, inventory = „опис“, privacy = „неприкосновеност (на личния живот)“ with confidentiality = „поверителност“, unauthorized = „неразрешен“. These follow the official editions where the interface differs; the interface is aligned separately.
6. **Every "(?)" in this file is settled for this run: use the term exactly as given.** Never copy "(?)" into a heading. If you are convinced a given term is wrong, still use it, and say so in your report.

# Glossary

**How to use it.** Look the English term up in "Core terms"; the Bulgarian column is the term, the note says when another word applies (another sense, or an official title). A family section (below) overrides the core table inside that family only. Nouns are given in the singular, indefinite; inflect as the heading needs. `(?)` at the start of a note marks a term that is decided but still doubtful (see "Open questions"): use the term, never copy the mark.

**Where each word comes from.** Product concepts (control, risk, asset, evidence, policy, finding, audit, vendor …) take the interface's word. Inside an EU act's own family the official Bulgarian edition wins. Titles of ISO clauses and controls take the БДС wording. Everything else takes the standards vocabulary below.

## Core terms
Verbs and past participles (establish, established …) are in the next section; roles, categories and labels in the one after.

| English | Bulgarian | Note |
|---|---|---|
| access | достъп | access management = управление на достъпа; access rights = права за достъп; access review = преглед на достъпа; privileged / remote / logical / physical / administrative access = привилегирован / отдалечен / логически / физически / администраторски достъп |
| access control | контрол на достъпа | Singular also for "access controls" |
| account | акаунт | IT. A ledger account (COSO "account reconciliations") = сметка. service account = служебен акаунт |
| accountability | отчетност | Not „отговорност“ (= responsibility). accountable (person, owner) = отговорен |
| action | действие | pl. действия. corrective action = коригиращо действие |
| activity | дейност | pl. дейности. Never „активност“ |
| agent | агент | AI agent = ИИ агент; agentic = агентен; multi-agent = многоагентен; inter-agent = между агенти |
| agreement | споразумение | agreed (by the parties) = съгласуван. consent is a different word (съгласие) |
| AI | ИИ | "AI + noun" = noun + „на ИИ“ / „за ИИ“ / „с ИИ“: политика за ИИ, управление на ИИ, модел на ИИ, сигурност на ИИ, риск, свързан с ИИ. Only „ИИ агент“ puts the acronym first |
| AI system | система с ИИ | AI Act and БДС wording, in every family. Never „ИИ система“, „AI система“. high-risk AI system = високорискова система с ИИ. AI management system = система за управление на ИИ |
| analysis | анализ | root cause analysis = анализ на първопричините |
| annex | приложение | The letter stays Latin: „приложение A“, „Приложение IV“ |
| anomaly | аномалия | anomaly detection = откриване на аномалии; anomalous = необичаен |
| application | приложение | application security = сигурност на приложенията. Annex is the same word; the context decides |
| approval | одобрение | sign-off = писмено одобрение; human approval = одобрение от човек |
| article | член | "Article 21 - …" = „Член 21 - …“; an article reference written "Art" or "Art." inside a heading becomes „чл.“ with its numbers unchanged: "(Art 24-27)" = „(чл. 24-27)“. Lower case inside brackets: „(член 28)“ |
| artifact | артефакт | pl. артефакти |
| assessment | оценка | Also "evaluation". Official ISO clause titles, NIS2 and AI Act wording only: оценяване |
| asset | актив | pl. активи. asset management = управление на активите; enterprise assets = активи на предприятието; information / software assets = информационни / софтуерни активи |
| audit | одит | internal audit = вътрешен одит; auditor = одитор; audit committee = одитен комитет |
| audit log | одитен дневник | pl. одитни дневници. audit trail = одитна следа |
| authentication | удостоверяване | multi-factor / strong / secure authentication = многофакторно / силно / сигурно удостоверяване. NIS2 Art. 21(2)(j) only: удостоверяване на автентичността |
| authority | правомощия | Power to decide (authority limits = лимити на правомощията). A public body = орган (competent authority = компетентен орган); ISO 5.5 "authorities" = органи на властта |
| authorization | оторизация | The access decision ("Authentication & Authorization"). A permission that is given = разрешение ("Change Authorization" = Разрешаване на промени; UAS "operational authorisation" = разрешение за експлоатация) |
| availability | наличност | Not „достъпност“ |
| awareness | осведоменост | security awareness = осведоменост по сигурността. ISO clause 7.3 and control 6.3 official titles only: осъзнаване |
| backup | резервно копие | pl. резервни копия. "Backup Policy" = Политика за резервните копия. Not „архивиране“ |
| baseline | базова линия | Attributive: базов. Baseline Pack = Базов пакет; baseline configuration = базова конфигурация |
| basis | основание | lawful / legal basis = правно основание. "on an ongoing basis" = текущо |
| behavior | поведение | behavior-based = основан на поведението |
| bias | предубеденост | automation bias = предубеденост в полза на автоматизираните решения |
| breach | нарушение | data breach = нарушение на сигурността на данните; personal data breach (GDPR) = нарушение на сигурността на личните данни; privacy breach = нарушение на неприкосновеността. A break-in ("security breach", "Third-Party Vendor Breach") = пробив |
| build | изграждане | build pipeline = конвейер за изграждане |
| business | дейност | The undertaking. Attributive IT sense = бизнес (бизнес логика, бизнес среда) |
| business continuity | непрекъснатост на дейността | NIS2 Art. 21(2)(c) only: непрекъснатост на стопанската дейност. business impact analysis (BIA) = анализ на въздействието върху дейността (BIA) |
| category | категория | subcategory = подкатегория |
| certificate | сертификат | certification = сертифициране. UAS pilot certificate = свидетелство |
| chain | верига | See supply chain |
| change | промяна | pl. промени. change management = управление на промените; change control = контрол на промените |
| class | клас |  |
| classification | класификация | DORA Art. 18 only: класифициране |
| clause | точка | "Clause 7 - Support" = „Точка 7 - Поддържане“. A contract clause = клауза |
| cloud | облачен | Attributive: облачна среда, облачна конфигурация. cloud services = услуги в облак |
| code | код | source / executable / malicious code = изходен / изпълним / зловреден код; code review = преглед на кода |
| collection | събиране |  |
| communication | комуникация | Network sense, plural: комуникации. ISO clause 7.4 title only: обмен на информация |
| compliance | съответствие | compliance with X = съответствие с X; non-compliance, nonconformity = несъответствие |
| component | компонент | pl. компоненти |
| conditions | условия |  |
| confidentiality | поверителност |  |
| configuration | конфигурация | secure configuration = сигурна конфигурация; misconfiguration = неправилна конфигурация |
| consent | съгласие | explicit consent = изрично съгласие |
| content | съдържание |  |
| context | контекст | context of the organization = контекст на организацията |
| continuity | непрекъснатост |  |
| contract | договор | contractual requirements = договорни изисквания |
| control | контрол | A safeguard: masculine, pl. контроли; never „контрола“, never „механизъм за контрол“. internal control = вътрешен контрол; security control = контрол за сигурност; key control = ключов контрол. To govern ("Document Control", ISO 9001 "Control of …", "Operational planning and control") = управление |
| control activities | контролни дейности | COSO, SOC 2 CC5. control environment = контролна среда |
| controller | администратор | GDPR. ISO 27701: администратор на PII. The finance role (CFO/Controller) = контрольор |
| credentials | идентификационни данни | UAS pilot credentials = свидетелства |
| criteria | критерии |  |
| cryptography | криптография | cryptographic = криптографски |
| customer | клиент |  |
| cybersecurity | киберсигурност | cyber- is written together: киберзаплаха, кибератака, киберхигиена |
| data | данни | Always plural. data protection = защита на данните; data security = сигурност на данните; data quality = качество на данните; data flow = поток от данни |
| data action | действие с данни | NIST Privacy. problematic data action = проблемно действие с данни |
| data element | елемент от данни | NIST Privacy. pl. елементи от данни |
| data processing | обработване на данни | Never „обработка“. data processing ecosystem = екосистема за обработване на данни |
| data subject | субект на данните | data subject rights = права на субектите на данни. Official GDPR titles: see the gdpr table |
| decision | решение | pl. решения |
| default | по подразбиране |  |
| deletion | изтриване | Also "erasure" |
| deployment | внедряване | Also "implementation". pre-deployment = преди внедряване; deployer (AI Act) = внедрител |
| design | проектиране | The activity. The result = проект. by design = на етапа на проектирането. Not „дизайн“ |
| detection | откриване |  |
| development | разработване | Not „разработка“, not „развитие“. software development = разработване на софтуер; secure development = сигурно разработване |
| device | устройство | end-user devices = устройства на крайните потребители |
| disclosure | разкриване | Of data, PII. To the public, of vulnerabilities, in financial statements, that AI is in use = оповестяване |
| disposal | унищожаване | Of data, media. Of equipment or assets = извеждане от употреба |
| document | документ | documentation = документация; documented information = документирана информация |
| due diligence | надлежна проверка |  |
| duties | задължения | segregation / separation of duties = разделяне на задълженията |
| e.g. | напр. | i.e. = т.е.; etc. = и др. |
| ecosystem | екосистема | ecosystem parties = страни в екосистемата |
| effectiveness | ефективност |  |
| email | електронна поща |  |
| employee | служител | Also "workforce member" |
| encryption | криптиране | Not „шифроване“, not „кодиране“ (= encoding). at rest = в покой; in transit = при пренос |
| endpoint | крайно устройство | A device ("Endpoint Security" = Сигурност на крайните устройства). Of an API = крайна точка |
| enforcement | налагане |  |
| enterprise | предприятие | CIS |
| environment | среда | IT. Physical = околна среда |
| equipment | оборудване |  |
| event | събитие | security event = събитие, свързано със сигурността. Not the same as an incident |
| evidence | доказателство | pl. доказателства |
| exception | изключение | To a policy. Noted by an auditor (SOC report) = отклонение |
| execution | изпълнение |  |
| failure | отказ | Of systems. cascading failures = каскадни откази |
| file | файл |  |
| filtering | филтриране |  |
| finding | констатация | Never „находка“ |
| framework | рамка | A framework's NAME stays Latin |
| governance | управление | AI Act "data governance" only: администриране на данните |
| guardrail | предпазен механизъм | pl. предпазни механизми |
| handling | боравене | With data, assets: боравене с данни. Of incidents, errors, requests = обработване. NIS2 "incident handling" = действия при инцидент |
| hardening | укрепване на защитата | (?) hardened = укрепен |
| high-risk | високорисков |  |
| human | човешки | human oversight = човешки контрол (AI Act Art. 14); human review = преглед от човек; human-in-the-loop = с участието на човек; human resources = човешки ресурси |
| ICT | ИКТ | DORA: „… в областта на ИКТ“; NIS2: „ИКТ продукт / услуга / процес“ |
| identification | идентификация | Of a person, a device; the NIST function Identify. Finding risks, assets, changes = идентифициране |
| identity | идентичност | In a system (identity management = управление на идентичността). Who a person is = самоличност (identity proofing = доказване на самоличността) |
| impact | въздействие | impact assessment = оценка на въздействието |
| implementation | внедряване | Of a measure, a rule, roles: въвеждане |
| improvement | подобряване | continual improvement = непрекъснато подобряване. CSF "Improvements" = Подобрения |
| incident | инцидент | incident management = управление на инциденти; security incident = инцидент със сигурността. Official ISO titles: инцидент, свързан със сигурността на информацията |
| incident response | реакция при инциденти | incident handling = обработване на инциденти. ISO 5.26 official title: реагиране при инциденти |
| individuals | физически лица | Never „индивиди“ |
| information | информация |  |
| information security | информационна сигурност | Official ISO/IEC 27001 and 27002 titles only: сигурност на информацията |
| information sharing | обмен на информация | Plain "sharing" (of data, PII) = споделяне |
| infrastructure | инфраструктура |  |
| injection | инжектиране | prompt injection = инжектиране на подкана; SQL injection = SQL инжектиране |
| input | входящи данни | input validation = валидиране на входящите данни. Not „входни данни“ |
| integrity | цялост | Of data, systems, software, models. Ethical sense (COSO P1, SOC 2 CC1.1) = почтеност. Never „интегритет“ |
| internal | вътрешен | external = външен |
| inventory | опис | „Опис на активите“. Never „инвентар“, „инвентаризация“. inventoried = описан |
| key | ключ | Cryptographic: key management = управление на ключове. As an adjective = ключов |
| leakage | изтичане | data leakage prevention = предотвратяване на изтичане на данни |
| legal | правен | legal, regulatory and contractual requirements = правни, регулаторни и договорни изисквания |
| life cycle | жизнен цикъл | Also "lifecycle" |
| limit | ограничение | pl. ограничения. authority limits = лимити на правомощията; rate limiting = ограничаване на честотата на заявките |
| log | дневник | pl. дневници. Never „лог“, „журнал“ |
| logging | водене на дневници | "Logging & Monitoring" = Водене на дневници и наблюдение. ISO 8.15 official title only: записване на събития |
| logic | логика | business logic = бизнес логика |
| maintenance | поддръжка | UAS family: техническо обслужване |
| malware | зловреден софтуер | anti-malware = срещу зловреден софтуер |
| management | управление | The activity. The people ("Management", "top management") = ръководство (висше ръководство). security management = управление на сигурността; management review = преглед от ръководството |
| management system | система за управление |  |
| measure | мярка | pl. мерки. technical and organisational measures = технически и организационни мерки |
| mechanism | механизъм | pl. механизми |
| media | носители | removable media = преносими носители; storage media = носители за съхранение. Never „медии“ |
| memory | памет |  |
| metadata | метаданни |  |
| mitigation | смекчаване | "a mitigation" (FINOS) = мярка за смекчаване |
| model | модел | AI model = модел на ИИ; general-purpose AI model = модел на ИИ с общо предназначение |
| monitoring | наблюдение | continuous monitoring = непрекъснато наблюдение. COSO / SOC 2 CC4 component only: мониторинг |
| network | мрежа | network security = мрежова сигурност; network segmentation = сегментиране на мрежата |
| notification | уведомяване | The act. The document = уведомление. Never „известие“ |
| objective | цел | pl. цели |
| obligation | задължение | pl. задължения |
| operation | експлоатация | Of systems ("System Operations" = Експлоатация на системите) and of UAS. Category "Operations" = Операции; "Operations Security" = Сигурност на операциите. ISO clause 8 "Operation" = Функциониране |
| operational | оперативен | UAS family: експлоатационен |
| organization | организация | organizational = организационен; "the organization's" = на организацията |
| output | резултат | Of a model, an agent, an AI system; pl. резултати. Of ordinary software = изходни данни (output encoding = кодиране на изхода). ISO 9001 8.7 = изходни елементи |
| oversight | надзор |  |
| owner | отговорник | Of a control, risk, asset, policy, evidence, vendor, finding, task (the interface's owner field). Of a system, data, a process, an account, an agent = собственик |
| pack | пакет | Baseline Pack = Базов пакет; Starter Pack = Начален пакет; Core Pack = Основен пакет |
| party | страна | pl. страни. interested parties / stakeholders = заинтересовани страни |
| password | парола |  |
| patch | корекция | patch management = управление на корекциите; unpatched = без приложена корекция |
| people | хора |  |
| performance | резултатност | Of a management system (ISO clause 9). Technical = производителност. Of people (performance evaluation, objectives) = изпълнение |
| personal data | лични данни | personal information = лична информация. Not the same as PII |
| personnel | персонал |  |
| physical | физически | physical security = физическа сигурност; physical and environmental security = физическа сигурност и сигурност на околната среда |
| PII | PII | Stays Latin; never „ЛД“, never „лични данни“ |
| plan | план | planning = планиране; "X Plan" = „План за X“ |
| policy | политика | pl. политики. "X Policy" = „Политика за X“; "X Management Policy" = „Политика за управление на X“; security policy = политика за сигурност; policies, processes and procedures = политики, процеси и процедури |
| practice | практика | pl. практики. best practices = добри практики |
| prevention | предотвратяване |  |
| principle | принцип | pl. принципи |
| privacy | неприкосновеност | Stand-alone: „Неприкосновеност на личния живот“; privacy risk = риск за неприкосновеността. Not „поверителност“. Fixed exceptions: политика за поверителност (privacy policy), уведомление за поверителност (privacy notice), диференциална поверителност |
| privilege | привилегия | pl. привилегии. least privilege = най-малки привилегии; privileged = привилегирован |
| procedure | процедура | "X Procedure" = „Процедура за X“ |
| process | процес | pl. процеси |
| processing | обработване | Never „обработка“ |
| processor | обработващ лични данни | GDPR. ISO 27701: обработващ PII. Never „процесор“ |
| product | продукт | products and services = продукти и услуги |
| production | производствена среда | (?) IT environment; attributive: производствен. ISO 8.31 official title: експлоатация. ISO 9001 8.5 = производство |
| prompt | подкана |  |
| protection | защита |  |
| provenance | произход | Not „източник“ (= source) |
| provider | доставчик | service provider = доставчик на услуги. Same word as vendor and supplier |
| purpose | цел | Of processing. Of a system ("intended purpose") = предназначение |
| quality | качество |  |
| record | запис | pl. записи. GDPR Art. 30 "records of processing activities" = регистър на дейностите по обработване |
| recovery | възстановяване | Also "restore". disaster recovery = възстановяване след бедствие |
| red teaming | атакуващо тестване | AI Act "adversarial testing" only: състезателно изпитване |
| register | регистър | risk register = регистър на рисковете. DORA "Register of Information" = информационен регистър |
| release | издание | A version (software release = издание на софтуера). The act = пускане (release criteria = критерии за пускане; pre-release = преди пускане) |
| remediation | отстраняване |  |
| remote | отдалечен | Access, device, maintenance. remote working = работа от разстояние; remote wipe = дистанционно изтриване |
| report | доклад | Auditor's, SOC, incident. A finance or system report ("key reports") = отчет |
| reporting | докладване | Of incidents, concerns. Financial reporting = финансово отчитане |
| request | заявка | HTTP, API, DNS. Of a data subject or for disclosure = искане |
| requirement | изискване | pl. изисквания. security requirements = изисквания за сигурност |
| resilience | устойчивост | Also "robustness" (AI Act Art. 15 only: надеждност) |
| resources | ресурси |  |
| response | реакция | To an incident, a risk. HTTP or model response = отговор |
| responsibility | отговорност | roles and responsibilities = роли и отговорности |
| retention | съхранение | Not „задържане“ |
| retrieval | извличане | Not „възстановяване“ |
| review | преглед |  |
| rights | права |  |
| risk | риск | pl. рискове. risk mitigation = смекчаване на риска; risk treatment = третиране на риска; risk tolerance = толерантност към риска; risk response = реакция на риска; third-party risk = риск, свързан с трети страни; security risk = риск за сигурността |
| risk assessment | оценка на риска |  |
| risk management | управление на риска |  |
| role | роля | pl. роли |
| root cause | първопричина |  |
| rule | правило | pl. правила |
| safeguard | защитна мярка | CIS |
| safety | безопасност | Never „сигурност“ |
| sandbox | изолирана среда | sandboxing = изолирано изпълнение |
| scope | обхват |  |
| screening | проучване | Of people. Of content, input = проверка |
| secret | тайна | pl. тайни |
| secure | сигурен | securely = по сигурен начин; secure coding = сигурно програмиране (not „кодиране“). "well-secured software" = добре защитен софтуер |
| security | сигурност |  |
| segregation | разделяне | Of duties, networks, environments. Also "separation" |
| sensitive | чувствителен | sensitive data = чувствителни данни |
| service | услуга | pl. услуги |
| session | сесия |  |
| significant | съществен | NIS2 "significant incident" only: значителен |
| software | софтуер | third-party software = софтуер от трети страни |
| source | източник | source code = изходен код |
| specific | специфичен | role-specific = според ролята |
| standard | стандарт | UAS "standard scenario" = основен сценарий |
| state | състояние | Of an agent, a system. A country (Member State) = държава |
| storage | съхранение |  |
| subject | субект |  |
| supplier | доставчик | supplier relationships = взаимоотношения с доставчици |
| supply chain | верига за доставки | NIS2 family only: верига за доставка. AI Act family only: верига на доставки |
| support | поддържане | ISO clause 7 title only. Vendor support: supported = поддържан |
| system | система |  |
| technical | технически | technological = технологичен |
| tenant | наемател | cross-tenant = между наематели |
| testing | тестване | test = тест; penetration testing = тестване за проникване. Official ISO titles and AI Act wording only: изпитване |
| third party | трета страна | pl. трети страни. third-party software = софтуер от трети страни; third-party testing = тестване от трета страна |
| threat | заплаха | threat intelligence = разузнавателни сведения за заплахи |
| time | време | real-time = в реално време |
| token | токен | pl. токени |
| tool | инструмент | tool call = извикване на инструмент |
| training | обучение | Of people and of models. training data = обучителни данни |
| transfer | предаване | Of data across borders, of PII. Of ownership, of risk = прехвърляне. ISO 5.14 "information transfer" = пренос на информация |
| transparency | прозрачност |  |
| trust | доверие | trusted = доверен |
| UAS | БЛС | UAS operations = експлоатация на БЛС; open category = „неограничена“ категория; specific category = „специфична“ категория; operational authorisation = разрешение за експлоатация; remote pilot = дистанционно управляващ пилот; aircraft = въздухоплавателно средство |
| unauthorized | неразрешен | Access, action, software, device, change. authorized (software, asset) = разрешен; authorized person = оправомощено лице |
| user | потребител | end-user = краен потребител |
| validation | валидиране | validity = валидност |
| value | стойност | ethical values = етични ценности |
| vendor | доставчик | third-party vendor = външен доставчик |
| verification | проверка | checks = проверки |
| vulnerability | уязвимост | pl. уязвимости. vulnerability management = управление на уязвимостите; vulnerability disclosure = оповестяване на уязвимости. DORA only: уязвимо място |
| web | уеб |  |
| workforce | служители | Never „работна сила“ |

## Verbs for imperative headings
Polite imperative, 2nd person plural. Where two forms are given („Оценете · Оценявайте“): the first is for a task or a set-up act that is finished once done; the second for a standing or recurring duty, i.e. when the heading or its `ctx` says or implies repetition (regularly, periodically, continuously, ongoing, each, every, annually; or the object is an open stream such as incidents, vulnerabilities, requests, changes, logs). Still unsure in a control or safeguard title: second form for apply, assess, collect, conduct, enforce, notify, perform, prevent, remediate, review, test, train, verify; first form for the rest. Two verbs joined by "and" take the same aspect („Създайте и поддържайте“ is the fixed exception).

| English verb | Bulgarian imperative | English verb | Bulgarian imperative | English verb | Bulgarian imperative | English verb | Bulgarian imperative | English verb | Bulgarian imperative | English verb | Bulgarian imperative |
|---|---|---|---|---|---|---|---|---|---|---|---|
| address (a risk) | Овладейте | address (anything else) | Предприемете мерки спрямо | align | Съгласувайте | allocate | Разпределете | allowlist | Включете в разрешителен списък | analyze | Анализирайте |
| apply | Приложете · Прилагайте | archive | Архивирайте | assess, evaluate | Оценете · Оценявайте | assign | Възложете | block | Блокирайте | centralize | Централизирайте |
| check, screen | Проверявайте | collect | Съберете · Събирайте | communicate | Комуникирайте | conduct (audit, review, test, training, exercise) | Проведете · Провеждайте | configure | Конфигурирайте | create | Създайте · Създавайте |
| decommission | Изведете от експлоатация | define, determine, designate, set | Определете | deploy | Внедрете | design | Проектирайте | detect | Откривайте | develop | Разработете |
| disable | Деактивирайте | dispose of (data, media) | Унищожете · Унищожавайте | document | Документирайте | enable | Активирайте | encrypt | Криптирайте | enforce | Наложете · Налагайте |
| ensure + clause | Гарантирайте, че | ensure + noun | Осигурете | establish | Създайте | filter | Филтрирайте | flag | Маркирайте | grant | Предоставете · Предоставяйте |
| harden | Укрепете | identify | Идентифицирайте | implement | Внедрете | implement (a measure, a rule, roles) | Въведете | implement (a plan, a risk treatment) | Изпълнете | incorporate | Включете |
| isolate | Изолирайте | limit, restrict | Ограничете · Ограничавайте | log | Регистрирайте | maintain | Поддържайте | manage | Управлявайте | mask | Маскирайте |
| mitigate | Смекчете · Смекчавайте | monitor | Наблюдавайте | notify | Уведомете · Уведомявайте | obtain | Получете · Получавайте | perform | Извършете · Извършвайте | pin (a version) | Фиксирайте |
| plan | Планирайте | prepare | Подгответе | prevent | Предотвратете · Предотвратявайте | protect, secure | Защитете · Защитавайте | provide (information, a document) | Предоставете · Предоставяйте | provide (means, a mechanism, resources) | Осигурете |
| quarantine | Поставете под карантина | record | Записвайте | reject | Отхвърляйте | remediate | Отстранете · Отстранявайте | remove | Премахнете · Премахвайте | report | Докладвайте |
| require | Изисквайте | respond (to) | Реагирайте (на) | retain, store | Съхранявайте | review | Прегледайте · Преглеждайте | revoke | Отнемете · Отнемайте | rotate | Ротирайте |
| sanitize | Пречистете · Пречиствайте | scan | Сканирайте | segment | Сегментирайте | separate, segregate | Разделете | share | Споделяйте | sign | Подписвайте |
| standardize | Стандартизирайте | test | Тествайте | track | Проследявайте | train | Обучете · Обучавайте | tune | Настройте · Настройвайте | understand | Разберете |
| uninstall | Деинсталирайте | use, utilize, leverage | Използвайте | validate | Валидирайте | verify | Проверете · Проверявайте |  |  |  |  |

**Participles and statement headings.** A heading that states an outcome keeps that form; it does not become an imperative.

- approved = одобрен; agreed = съгласуван; assessed = оценен; associated = свързан; authenticated = удостоверен; automated = автоматизиран; communicated = комуникиран; controlled = контролиран; current, kept current = актуален, поддържа се актуален; defined = определен; detected = открит; documented = документиран; established = създаден; identified = идентифициран; implemented = внедрен (statement: „е внедрен“ / „се прилага“); in place = се прилага; logged = регистриран; maintained = поддържан; managed = управляван; performed = извършен; protected = защитен; reviewed = прегледан (recurring: преглеждан); tested = тестван; at least annually = поне веднъж годишно.

| Source pattern | Bulgarian pattern |
|---|---|
| "X + past participle(s)" title ("Changes assessed, approved and traceable") | Reflexive passive, present tense: „Промените се оценяват, одобряват и са проследими“ |
| NIST outcome statement ("X are identified and managed.") | „X са идентифицирани и се управляват.“ (keep the full stop of the source) |
| "X are established and in place." / "X are inventoried." | „X са създадени и се прилагат.“ / „X са описани.“ |
| "X can be accessed for Y." | „До X може да се осъществи достъп за Y.“ |
| "No X" (ASVS: "No Password Hints") | „Без X“ („Без подсказки за пароли“) |
| "X Compliance" / "X Control" / "X Management" / "X Verification" (internal controls) | „Съответствие на X“ or „Съответствие с X“ / „Контрол на X“ / „Управление на X“ / „Проверка на X“ |
| "-ing" heading ("Managing changes", "Communicating X") | Verbal noun: „Управление на промените“, „Комуникиране на X“ |
| A code in front or in brackets ("PO.1 …", "ASI01 …", "C2.1 …", "D1 …", "A. …", "(ASVS L1)", "(IG1)", "(AISVS C5)") | Copied unchanged, in the same place |
| "&" / "and/or" / "(24h)" / "(1 month)" | „и“ / „и/или“ / „(24 ч)“ / „(1 месец)“ |
| After " - " or " — " | The title keeps its capital: „Член 21 - Мерки за …“, „Контрол 5 — Управление на акаунтите“ |
| After ":" | Lower case: „Ниво на риск: високорискови системи с ИИ“ |

## Roles, categories and labels
Every value of `closed-sets.json`: 23 roles, 103 categories, 13 labels. Pattern for a category that begins with a framework name: the name stays as it is, then a colon, then lower case („AIUC-1: сигурност“); a value that is only a name is returned unchanged. "EU UAS" is not a name but two acronyms with official Bulgarian forms („БЛС в ЕС“). Adjective categories are masculine singular (they agree with „риск“ / „контрол“). Values used by one EU family only follow that act („Верига за доставка“, „Оценяване“ are NIS2; „Управление на риска, пораждан от трети страни“ is DORA). Roles are nouns without an article. "Communication Procedure and" is cut off in the source; the cut is reproduced.

| suggestedRole | Bulgarian | suggestedRole | Bulgarian | suggestedRole | Bulgarian | suggestedRole | Bulgarian | suggestedRole | Bulgarian |
|---|---|---|---|---|---|---|---|---|---|
| Accountable manager | Отговорен управител | Audit Committee | Одитен комитет | CFO/Controller | Финансов директор/контрольор | Compliance manager | Ръководител по съответствието | Data protection officer | Длъжностно лице по защита на данните |
| Engineering lead | Ръководител на инженерния екип | Executive management | Изпълнително ръководство | Facilities | Административно-стопански отдел | Fleet and maintenance lead | Ръководител на флота и техническото обслужване | Flight operations lead | Ръководител на летателната експлоатация |
| IT Operations | ИТ операции | Internal Audit | Вътрешен одит | Legal/Compliance | Правен отдел/Съответствие | Legal/DPO | Правен отдел/ДЛЗД | Management | Ръководство |
| Operations manager | Оперативен ръководител | Process Owner | Собственик на процеса | Procurement | Снабдяване | Remote pilot | Дистанционно управляващ пилот | Safety manager | Ръководител по безопасността |
| Security engineering | Инженерен екип по сигурността | Security lead | Ръководител по сигурността | Training lead | Ръководител на обучението |  |  |  |  |

| category | Bulgarian | category | Bulgarian | category | Bulgarian | category | Bulgarian | category | Bulgarian |
|---|---|---|---|---|---|---|---|---|---|
| AI management system | Система за управление на ИИ | AIUC-1 Accountability | AIUC-1: отчетност | AIUC-1 Data & Privacy | AIUC-1: данни и неприкосновеност на личния живот | AIUC-1 Reliability | AIUC-1: надеждност | AIUC-1 Safety | AIUC-1: безопасност |
| AIUC-1 Security | AIUC-1: сигурност | AIUC-1 Society | AIUC-1: общество | Annex A controls | Контроли от приложение A | Application Security | Сигурност на приложенията | Assessment | Оценяване |
| Awareness & HR | Осведоменост и човешки ресурси | Backup & Recovery | Резервни копия и възстановяване | Business Impact Analysis | Анализ на въздействието върху дейността | Change Management | Управление на промените | Communicate | Комуникация |
| Communication Procedure and | Процедура за комуникация и | Compliance | Съответствие | Control | Контрол | Control Activities | Контролни дейности | Control Environment | Контролна среда |
| Controller & Processor | Администратор и обработващ лични данни | Core | Основни | Crisis Management | Управление на кризи | Cryptography | Криптография | Cyber Hygiene | Киберхигиена |
| Cybersecurity | Киберсигурност | Data Subject Rights | Права на субекта на данни | Detect | Откриване | Development | Разработване | Document Control | Управление на документите |
| EU AI Act | Акт за изкуствения интелект на ЕС | EU UAS Every operation | БЛС в ЕС: всяка експлоатация | EU UAS LUC | БЛС в ЕС: LUC | EU UAS Open A1 | БЛС в ЕС: неограничена A1 | EU UAS Open A2 | БЛС в ЕС: неограничена A2 |
| EU UAS Open A3 | БЛС в ЕС: неограничена A3 | EU UAS Open category | БЛС в ЕС: неограничена категория | EU UAS Operational authorisation | БЛС в ЕС: разрешение за експлоатация | EU UAS STS-01 | БЛС в ЕС: STS-01 | EU UAS STS-02 | БЛС в ЕС: STS-02 |
| EU UAS Specific category | БЛС в ЕС: специфична категория | EU UAS Standard scenarios | БЛС в ЕС: основни сценарии | Endpoint | Крайни устройства | Endpoint Security | Сигурност на крайните устройства | FINOS AIGF Access | FINOS AIGF: достъп |
| FINOS AIGF Data | FINOS AIGF: данни | FINOS AIGF Evaluation | FINOS AIGF: оценка | FINOS AIGF Filtering | FINOS AIGF: филтриране | FINOS AIGF Monitoring | FINOS AIGF: наблюдение | FINOS AIGF Oversight | FINOS AIGF: надзор |
| FINOS AIGF Sourcing | FINOS AIGF: снабдяване | Govern | Управление | Governance | Управление | HR Security | Сигурност на човешките ресурси | ICT Risk Management | Управление на риска в областта на ИКТ |
| IMDA MGF | IMDA MGF | ISO 42001 | ISO 42001 | Identify | Идентификация | Incident Management & Reporting | Управление и докладване на инциденти | Incident Response | Реакция при инциденти |
| Information Sharing | Обмен на информация | International Transfers | Международно предаване на данни | Legal | Правен | Logging & Monitoring | Водене на дневници и наблюдение | Logical Access | Логически достъп |
| Monitoring Activities | Дейности по мониторинг | NIST Privacy | NIST Privacy | Network Security | Мрежова сигурност | OWASP AISVS | OWASP AISVS | Operational | Оперативен |
| Operations | Операции | Operations Security | Сигурност на операциите | Organizational | Организационен | PII Controller | Администратор на PII | PII Processor | Обработващ PII |
| PIMS Controls | Контроли на PIMS | People | Хора | Physical | Физически | Prepare the Organization | Подгответе организацията | Principles | Принципи |
| Produce Well-Secured Software | Създавайте добре защитен софтуер | Protect | Защита | Protect the Software | Защитете софтуера | Recover | Възстановяване | Reporting | Докладване |
| Reputational | Репутационен | Resilience Testing | Тестване на устойчивостта | Respond | Реакция | Respond to Vulnerabilities | Реагирайте на уязвимости | Risk Mitigation | Смекчаване на риска |
| Risk tier: General-purpose AI models | Ниво на риск: модели на ИИ с общо предназначение | Risk tier: High-risk AI systems | Ниво на риск: високорискови системи с ИИ | Risk tier: Limited-risk (transparency obligations) | Ниво на риск: ограничен риск (задължения за прозрачност) | Risk tier: Minimal-risk AI systems | Ниво на риск: системи с ИИ с минимален риск | Risk tier: Prohibited AI practices | Ниво на риск: забранени практики в областта на ИИ |
| Security | Сигурност | Supply Chain | Верига за доставка | System Operations | Експлоатация на системите | Technical | Технически | Technological | Технологичен |
| Third-Party Risk Management | Управление на риска, пораждан от трети страни | Training | Обучение | Vendor | Доставчици |  |  |  |  |

| label | Bulgarian | label | Bulgarian | label | Bulgarian | label | Bulgarian | label | Bulgarian |
|---|---|---|---|---|---|---|---|---|---|
| All In-house | Изцяло вътрешно | At least every Year | Поне веднъж годишно | Encryption | Криптиране | Encryption+Strong Authentication | Криптиране+силно удостоверяване | Encryption+Strong Authentication+Antivirus/Malware | Криптиране+силно удостоверяване+антивирус/зловреден софтуер |
| Less than half | По-малко от половината | Manual | Ръчно | More than Half | Повече от половината | No | Не | None | Няма |
| Not regularly | Нередовно | Programatically | Програмно | Yes | Да |  |  |  |  |

## Acronyms
Identifiers that contain an acronym ("PIMS-02", "AIMS-05B", "TSC-CC6-1", "IC-136", "ASVS-V2") are codes: never translated. An acronym is not expanded unless the source expands it.

| English | Bulgarian form | English | Bulgarian form | English | Bulgarian form |
|---|---|---|---|---|---|
| AI | ИИ | ICT | ИКТ | IT | ИТ |
| EU | ЕС | HR | ЧР (in a title prefer „човешки ресурси“) | UAS | БЛС |
| ISMS | СУСИ | QMS | СУК | RTS (road traffic safety) | БДП |
| BCMS | BCMS (stays in Latin) | PIMS | PIMS (stays in Latin) | AIMS | AIMS (stays in Latin) |
| DPO | ДЛЗД | DPIA | ОВЗД | CBRN | ХБРЯ |
| CSIRT (NIS2) | CSIRT (stays in Latin, as in the interface) | ESAs (DORA) | ЕНО | GPAI | written out: ИИ с общо предназначение |
| ML | written out: машинно обучение | DR | written out: възстановяване след бедствие | IP (intellectual property) | written out: интелектуална собственост |
| SoD | written out: разделяне на задълженията | CFO | written out: финансов директор | TLD (NIS2) | written out: домейн от първо ниво |

| Stay in Latin | Acronyms |
|---|---|
| Frameworks, bodies | ISO/IEC, NIST, CSF, SSDF, SP 800-218, CIS, OWASP, ASVS, AISVS, ASI, COSO, ICF, SOC 1, SOC 2, TSC, AICPA, FINOS, AIGF, IMDA, MGF, AIUC-1, GDPR, NIS2, DORA |
| Levels and codes | L1–L3, IG1, CC1–CC9, A1, C1, PI1, P1–P17, V1–V14, C1–C12, D1–D4, PO/PS/PW/RV, GV/ID/PR/DE/RS/RC, ID-P/GV-P/CT-P/CM-P/PR-P, STS-01, STS-02, C0–C6, A1–A3 |
| Security and IT | MFA, SSO, AAA, RBAC, ABAC, IAM, OTP, TOTP, JIT, API, DNS, DHCP, URL, HTTP, TLS, SSL, mTLS, VPN, DMARC, CORS, CSP, HSTS, DDoS, QoS, IoT, IP (address), XSS, CSRF, SSRF, SQL, LDAP, XML, CI/CD, SDLC, SAST, DAST, SCA, SBOM, AI BOM, OS, JSON, SOAP, GraphQL, SIEM, DLP, IDS, IPS, MDM, BYOD, PKI, SLA, KPI, KRI, BIA, ICS/OT, POS, POI, CVV, SAD, PII, ICFR, TLPT |
| AI | LLM, RAG, MCP, RLHF, GPU, TEE, DoW, LLM-as-a-Judge, jailbreak |
| Aviation | LUC, VLOS, BVLOS, MTOM, SORA, PDRA, ERP, U-space |

Word order: the Bulgarian noun comes after the acronym when the acronym names a kind („API ключ“, „MCP сървър“, „DNS заявки“, „URL филтри“, „SQL инжектиране“, „DDoS атака“); a policy, process or report puts it last („Политика за BYOD“, „управление на AAA“, „доклад SOC 1“). A bracketed acronym after its long form is kept: „Анализ на въздействието върху дейността (BIA)“.

## Framework families
A family table overrides "Core terms" inside that family only. Chunks named `<family>.N` belong to `<family>`.

**Names.** Returned byte-identical: "AIUC-1 AI Agent Standard", "CIS Critical Security Controls v8", "COSO Internal Control — Integrated Framework", "FINOS AI Governance Framework", "ISO/IEC 27001", "ISO/IEC 27001:2022", "ISO/IEC 27701:2019", "ISO/IEC 42001:2023", "NIST CSF v2.0", "NIST Cybersecurity Framework v2.0", "NIST Privacy Framework v1.0", "NIST SSDF (SP 800-218) v1.1", "OWASP Agentic AI Top 10", "OWASP AISVS v1.0", "OWASP Application Security Verification Standard 4.0.3", "SOC 2 (Trust Services Criteria)", "SOC 2 Trust Services Criteria". Names with a translatable part and packs:

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| AIUC-1 / DORA / FINOS AIGF / IMDA MGF / NIS2 / OWASP AISVS / SOC 2 Baseline Pack | Базов пакет AIUC-1 / DORA / FINOS AIGF / IMDA MGF / NIS2 / OWASP AISVS / SOC 2 | NIST Privacy Framework Baseline Pack | Базов пакет NIST Privacy Framework | OWASP Agentic AI Top 10 Baseline Pack | Базов пакет OWASP Agentic AI Top 10 |
| COSO ICF 2013 baseline | Базов пакет COSO ICF 2013 | EU AI Act Baseline Pack | Базов пакет по Акта за изкуствения интелект на ЕС | ISO 42001 AIMS Baseline Pack | Базов пакет за AIMS по ISO 42001 |
| CIS Controls v8 IG1 Pack | Пакет CIS Controls v8 IG1 | OWASP ASVS Level 1 Pack | Пакет OWASP ASVS Level 1 | NIST SSDF Core Pack / ISO 27701 Core Pack | Основен пакет NIST SSDF / Основен пакет ISO 27701 |
| ISO 27001:2022 Starter Pack | Начален пакет ISO 27001:2022 | ISO 27001 demo starter pack | Начален демонстрационен пакет ISO 27001 | ISO/IEC 27001 (demo subset) | ISO/IEC 27001 (демонстрационно подмножество) |
| Internal Control Library | Библиотека с вътрешни контроли | IMDA Model AI Governance Framework (May 2026) | IMDA Model AI Governance Framework (май 2026 г.) | OWASP AISVS — AI Vendor Security Questionnaire | OWASP AISVS — въпросник за сигурността на доставчици на ИИ |
| GDPR (Regulation (EU) 2016/679) | GDPR (Регламент (ЕС) 2016/679) |  |  |  |  |
### AI vocabulary (aiuc-1, eu-ai-act, finos-aigf, imda-mgf, iso-42001, owasp-agentic, owasp-aisvs)
- adversarial = враждебен („устойчивост на враждебни атаки“); alignment = съгласуваност; attestation (hardware, runtime) = атестация; circuit breaker = предпазител; citation = цитиране; confidence (score) = увереност; dataset = набор от данни; data lineage = родословие на данните; de-identification = деидентификация; delegation = делегиране; drift = дрейф; edge (device) = периферен; embedding = векторно представяне; explainability = обяснимост; fine-tuning = фино настройване; foundation model = базов модел; hallucination = халюцинация; harm, harmful = вреда, вреден; inference = извод; intended purpose = предназначение; jailbreak = jailbreak; kill switch = аварийно спиране; knowledge base = база знания; labeling (training data) = етикетиране; large language model = голям езиков модел; MCP server = MCP сървър;
- misuse, abuse = злоупотреба; model card = карта на модела; model weights = тегла на модела; observability = наблюдаемост; orchestration = оркестрация; over-reliance = прекомерно разчитане; plugin = приставка; poisoning = отравяне; rollback = връщане към предишна версия; scraping = автоматизирано извличане на съдържание; skill = умение; system prompt = системна подкана; tampering = манипулиране; taxonomy = таксономия; vector database, vector store = векторна база данни, векторно хранилище; version pinning = фиксиране на версията; watermark = воден знак; workload = работно натоварване.
### Security engineering vocabulary (cis-v8, internal-controls, iso-27001, nist-ssdf, owasp-asvs, policy-templates, generic, shared)
- acceptable use = приемливо използване; allowlist = разрешителен списък; capacity = капацитет; certificate = сертификат; clear desk and clear screen = чисто бюро и чист екран; cookie = бисквитка; data masking = маскиране на данни; digital signature = цифров подпис; encoding = кодиране; error handling = обработване на грешки; exercise (incident, continuity) = учение; firewall = защитна стена; hashing = хеширане; header = заглавка; installation = инсталиране; intrusion detection, prevention = откриване, предотвратяване на проникване; lessons learned = извлечени поуки; need-to-know = необходимост да се знае; perimeter = периметър; phishing = фишинг; pipeline = конвейер; ransomware = софтуер за откуп; redundancy = резервираност; rotation (keys, credentials) = ротация; sanitization = пречистване; schema = схема;
- server = сървър; social engineering = социално инженерство; source control = контрол на версиите; threat modeling = моделиране на заплахите; toolchain = верига от инструменти; triage = първична оценка; update = актуализация; upload, download = качване, изтегляне.
### aiuc-1
Domain headings keep their letter: "A. Data & Privacy" = „A. Данни и неприкосновеност на личния живот“; B. Сигурност; C. Безопасност; D. Надеждност; E. Отчетност; F. Общество.

- adversarial input = враждебни входящи данни; AI cyber misuse = злоупотреба с ИИ за кибератаки; AI disclosure mechanisms = механизми за оповестяване на използването на ИИ; AI failure plan = план за действие при отказ на ИИ; coding agent = агент за програмиране; cross-customer data exposure = разкриване на данни между клиенти; endpoint scraping = автоматизирано извличане на съдържание от крайни точки; hallucinated outputs = халюцинирани резултати; harmful / high risk / out-of-scope outputs = вредни / високорискови резултати / резултати извън предназначението; input data policy, output data policy = политика за входящите данни, политика за резултатите; IP violations = нарушения на интелектуалната собственост; moderation layer = слой за модериране; open-weight model = модел с отворени тегла;
- output over-exposure = прекомерно разкриване в резултатите; public release of technical details = публично оповестяване на технически подробности; trade secrets = търговски тайни.
### cis-v8
"Control N — Title" = „Контрол N — Заглавие“; the same title without the number, or with "(IG1)", takes the same words. Safeguard titles are imperatives. "(IG1)" is copied. enterprise = предприятие; Safeguard = защитна мярка; Implementation Group = група за внедряване.

| Control | Bulgarian | Control | Bulgarian | Control | Bulgarian |
|---|---|---|---|---|---|
| 1 Inventory and Control of Enterprise Assets | Опис и контрол на активите на предприятието | 2 Inventory and Control of Software Assets | Опис и контрол на софтуерните активи | 3 Data Protection | Защита на данните |
| 4 Secure Configuration of Enterprise Assets and Software | Сигурна конфигурация на активите и софтуера на предприятието | 5 Account Management | Управление на акаунтите | 6 Access Control Management | Управление на контрола на достъпа |
| 7 Continuous Vulnerability Management | Непрекъснато управление на уязвимостите | 8 Audit Log Management | Управление на одитните дневници | 9 Email and Web Browser Protections | Защита на електронната поща и уеб браузъра |
| 10 Malware Defenses | Защита срещу зловреден софтуер | 11 Data Recovery | Възстановяване на данни | 12 Network Infrastructure Management | Управление на мрежовата инфраструктура |
| 13 Network Monitoring and Defense | Наблюдение и защита на мрежата | 14 Security Awareness and Skills Training | Осведоменост по сигурността и обучение за умения | 15 Service Provider Management | Управление на доставчиците на услуги |
| 16 Application Software Security | Сигурност на приложния софтуер | 17 Incident Response Management | Управление на реакцията при инциденти | 18 Penetration Testing | Тестване за проникване |

- access granting / revoking process = процес за предоставяне / отнемане на достъп; active / passive discovery tool = инструмент за активно / пасивно откриване; anti-exploitation features = функции срещу експлоатиране на уязвимости; anti-malware signature updates = актуализации на сигнатурите срещу зловреден софтуер; application layer filtering = филтриране на приложния слой; autorun and autoplay = автоматично стартиране и автоматично възпроизвеждане; browser and email client extensions = разширения за браузъри и клиенти за електронна поща; currently supported = поддържан към момента; data inventory / software inventory = опис на данните / опис на софтуера; data retention = съхранение на данните („Налагайте сроковете за съхранение на данните“);
- dedicated computing resources = специално предназначени изчислителни ресурси; default / dormant accounts = акаунти по подразбиране / неактивни акаунти; device lockout = заключване на устройството; DNS filtering services = услуги за DNS филтриране; externally-exposed = достъпен отвън; hardening configuration templates = шаблони за конфигурации с укрепена защита; host-based intrusion detection solution = решение за откриване на проникване на ниво хост; network intrusion prevention solution = решение за предотвратяване на проникване в мрежата; network-based URL filters = мрежови URL филтри; network traffic flow logs = дневници на потоците мрежов трафик; port-level access control = контрол на достъпа на ниво порт; secure configuration process = процес за сигурно конфигуриране;
- security event alerting (thresholds) = сигнализиране за събития, свързани със сигурността (прагове за сигнализиране); severity rating system = система за оценка на сериозността; unauthorized assets / software = неразрешени активи / неразрешен софтуер; unintentional data exposure = неволно разкриване на данни; vetted modules = проверени модули; vulnerability scan = сканиране за уязвимости; "Centralize Network Authentication, Authorization, and Auditing (AAA)" = „Централизирайте мрежовото удостоверяване, оторизация и одит (AAA)“; "Securely Decommission Service Providers" = „Прекратявайте по сигурен начин отношенията с доставчици на услуги“.
### coso-icf
Section headings keep the two-letter code in front: „CE Контролна среда“, „RA Оценка на риска“, „CA Контролни дейности“, „IC Информация и комуникация“, „MA Дейности по мониторинг“. Titles of the form "X + participle" follow the statement pattern („Констатациите се проследяват до приключване“). "account" here is a ledger account (сметка) unless it is a user account.

| Principle | Bulgarian | Principle | Bulgarian | Principle | Bulgarian |
|---|---|---|---|---|---|
| P1 Commitment to integrity and ethical values | Ангажираност с почтеността и етичните ценности | P2 Board oversight responsibility | Отговорност на съвета за надзор | P3 Structures, authority and responsibility | Структури, правомощия и отговорности |
| P4 Commitment to competence | Ангажираност с компетентността | P5 Accountability enforcement | Налагане на отчетност | P6 Suitable objectives specified | Определяне на подходящи цели |
| P7 Risk identification and analysis | Идентифициране и анализ на риска | P8 Fraud risk assessment | Оценка на риска от измами | P9 Significant change identification and analysis | Идентифициране и анализ на съществени промени |
| P10 Selection and development of control activities | Избор и разработване на контролни дейности | P11 General controls over technology | Общи контроли върху технологиите | P12 Deployment through policies and procedures | Внедряване чрез политики и процедури |
| P13 Use of relevant information | Използване на уместна информация | P14 Internal communication | Вътрешна комуникация | P15 External communication | Външна комуникация |
| P16 Ongoing and separate evaluations | Текущи и отделни оценки | P17 Evaluation and communication of deficiencies | Оценка и съобщаване на недостатъците |  |  |

- account reconciliation = равнение на сметки; audit committee charter / internal audit charter = статут на одитния комитет / статут на вътрешния одит; close calendar = календар за счетоводно приключване; code of conduct = кодекс за поведение; complementary user entity controls = допълващи контроли на предприятието ползвател; confidential reporting channel = поверителен канал за подаване на сигнали; consolidation and intercompany eliminations = консолидация и вътрешногрупови елиминации; control design effectiveness = ефективност на проектирането на контролите; control self-assessment = самооценка на контролите; delegation of authority matrix = матрица за делегиране на правомощия; disclosures (financial) = оповестявания; emergency change = спешна промяна; end-user computing = изчисления от крайни потребители;
- estimates and judgements = приблизителни оценки и преценки; ICFR-relevant = от значение за ICFR; incentive structures = структури на стимулите; internal audit engagement = одитен ангажимент; journal entries = счетоводни записвания; key / non-key control = ключов / неключов контрол; key report = ключов отчет; management override = заобикаляне на контролите от ръководството; materiality threshold = праг на същественост; performance objectives = цели за изпълнение; pre-hire screening = проучване преди наемане; reported concerns = подадени сигнали; reporting lines = линии на отчетност; review control = контрол чрез преглед; risk-based internal audit plan = основан на риска план за вътрешен одит; risk-control matrix = матрица на рисковете и контролите; scheduled jobs = планирани задания;
- service organization = обслужваща организация; significant accounts = съществени сметки; SoD conflict matrix = матрица на конфликтите при разделяне на задълженията.
### dora
"DORA" stays Latin; cite the act as „Регламент (ЕС) 2022/2554“. ICT terms are built „… в областта на ИКТ“ / „… на ИКТ“ / „… с ИКТ“, never „ИКТ риск“, „ИКТ услуги“. "(Art 5-16)" becomes „(чл. 5-16)“. major incident = съществен инцидент; management body = ръководен орган; testing = тестване.

| Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading |
|---|---|---|---|---|---|---|---|---|
| Chapter II<br>(Art. 5-16) | ICT Risk Management<br>ICT Risk Management (Art 5-16)<br>Pillar 1 — ICT Risk Management | Управление на риска в областта на ИКТ<br>Управление на риска в областта на ИКТ (чл. 5-16)<br>Стълб 1 — Управление на риска в областта на ИКТ | Art.5 | Governance and organisation | Управление и организация | Art.6 | ICT risk management framework | Рамка за управление на риска в областта на ИКТ |
| Art.7 | ICT systems, protocols and tools | Системи и протоколи на ИКТ и основани на ИКТ инструменти | Art.8 | Identification | Идентифициране | Art.9 | Protection and prevention | Защита и предотвратяване |
| Art.10 | Detection | Откриване | Art.11 | Response and recovery | Реакция и възстановяване | Art.12 | Backup policies, restoration and recovery procedures | Политики и процедури за съхраняване на резервни копия, процедури и методи за възстановяване на информацията |
| Art.13 | Learning and evolving | Обучение и развитие | Art.16 | Simplified ICT risk management framework | Опростена рамка за управление на риска в областта на ИКТ | Chapter III<br>(Art. 17-23) | Incident Management & Reporting<br>ICT Incident Management & Reporting (Art 17-23)<br>Pillar 2 — ICT Incident Management & Reporting | Управление и докладване на инциденти<br>Управление и докладване на инциденти с ИКТ (чл. 17-23)<br>Стълб 2 — Управление и докладване на инциденти с ИКТ |
| Art.17 | ICT-related incident management process | Процес за управление на инцидентите с ИКТ | Art.18 | Classification of ICT-related incidents and cyber threats | Класифициране на инцидентите с ИКТ и киберзаплахите | Art.19 | Reporting of major ICT-related incidents and voluntary notification of significant cyber threats | Докладване за съществените инциденти с ИКТ и уведомяване на доброволен принцип за значителни киберзаплахи |
| Art.23 | Operational or security payment-related incidents | Операционни или свързани със сигурността инциденти, свързани с плащания | Chapter IV<br>(Art. 24-27) | Digital Operational Resilience Testing (Art 24-27)<br>Pillar 3 — Digital Operational Resilience Testing<br>Resilience Testing | Тестване на оперативната устойчивост на цифровите технологии (чл. 24-27)<br>Стълб 3 — Тестване на оперативната устойчивост на цифровите технологии<br>Тестване на устойчивостта | Art.24 | General requirements for the performance of digital operational resilience testing | Общи изисквания за тестването на оперативната устойчивост на цифровите технологии |
| Art.25 | Testing of ICT tools and systems | Тестване на инструментите и системите на ИКТ | Art.26 | Advanced testing of ICT tools, systems and processes based on TLPT | Обстойно тестване на инструментите, системите и процесите на ИКТ чрез тестване за проникване | Art.27 | Requirements for testers for the carrying out of TLPT | Изисквания към лицата, провеждащи тестване за проникване |
| Chapter V<br>(Art. 28-44) | ICT Third-Party Risk Management (Art 28-44)<br>Pillar 4 — ICT Third-Party Risk Management<br>Third-Party Risk Management | Управление на риска в областта на ИКТ, пораждан от трети страни (чл. 28-44)<br>Стълб 4 — Управление на риска в областта на ИКТ, пораждан от трети страни<br>Управление на риска, пораждан от трети страни | Art.28 | General principles (incl. Register of Information) | Общи принципи (вкл. информационен регистър) | Art.29 | Preliminary assessment of ICT concentration risk at entity level | Предварителна оценка на риска от концентрация на ИКТ на равнището на субектите |
| Art.30 | Key contractual provisions | Основни договорни клаузи | Art.31 | Designation of critical ICT third-party service providers | Определяне на третите страни критични доставчици на услуги в областта на ИКТ | Chapter VI<br>(Art. 45) | Information Sharing<br>Information Sharing (Art 45)<br>Pillar 5 — Information Sharing | Обмен на информация<br>Обмен на информация (чл. 45)<br>Стълб 5 — Обмен на информация |
| Art.45 | Information-sharing arrangements on cyber threat information and intelligence | Споразумения за обмен на информация и разузнавателни сведения за киберзаплахи |  |  |  |  |  |  |

Notes. Art.12: Full official title; Art.13: Official title; do not re-translate; Chapter III: „инциденти с ИКТ“; Art.23: First half of the title, as in the source; Art.26: The Bulgarian title has no „TLPT“; Chapter V: „пораждан от трети страни“; Art.28: „информационен регистър“.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| Digital Operational Resilience Act | Акт за оперативната устойчивост на цифровите технологии | Digital Operational Resilience Act (EU 2022/2554) | Акт за оперативната устойчивост на цифровите технологии (ЕС 2022/2554) | ICT governance and management-body accountability | Управление на ИКТ и отговорност на ръководния орган |
| Asset and dependency identification | Идентифициране на активите и зависимостите | Protection and prevention controls | Контроли за защита и предотвратяване | Anomalous-activity detection | Откриване на необичайни дейности |
| Response and recovery / ICT business continuity | Реакция и възстановяване / непрекъснатост на дейността на ИКТ | Backup, restoration and recovery procedures | Процедури за съхраняване на резервни копия и възстановяване | Learning and evolving (post-incident review) | Обучение и развитие (преглед на възникналите инциденти) |
| Crisis communication | Комуникация при криза | Incident classification | Класифициране на инцидентите | Major-incident reporting to competent authority | Докладване за съществени инциденти на компетентния орган |
| Payment-related operational/security incident handling | Действия при операционни или свързани със сигурността инциденти, свързани с плащания | Digital operational resilience testing programme | Програма за тестване на оперативната устойчивост на цифровите технологии | Threat-led penetration testing (TLPT) | Тестване за проникване (TLPT) |
| TLPT tester suitability and independence | Пригодност и независимост на лицата, провеждащи TLPT | ICT third-party risk strategy and Register of Information | Стратегия за риска в областта на ИКТ, пораждан от трети страни, и информационен регистър | ICT concentration-risk assessment | Оценка на риска от концентрация на ИКТ |
| Key contractual provisions for ICT services | Основни договорни клаузи за услуги в областта на ИКТ | Critical ICT third-party provider tracking | Проследяване на третите страни критични доставчици на услуги в областта на ИКТ | Cyber threat information-sharing arrangements | Споразумения за обмен на информация за киберзаплахи |

Vocabulary: financial entity = финансов субект; ICT risk = риск в областта на ИКТ; ICT services = услуги в областта на ИКТ; ICT systems = системи на ИКТ; ICT-related incident = инцидент с ИКТ; ICT third-party service provider = трета страна доставчик на услуги в областта на ИКТ; vulnerability = уязвимо място; register of information = информационен регистър; competent authority = компетентен орган.
### eu-ai-act
"EU AI Act" = „Акт за изкуствения интелект на ЕС“ (not „Закон за ИИ“, not „AI Act“); cite the act as „Регламент (ЕС) 2024/1689“. testing = изпитване; human oversight = човешки контрол; robustness = надеждност; data governance = администриране на данните; provider = доставчик; deployer = внедрител.

| Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading |
|---|---|---|---|---|---|---|---|---|
| Chapter II | Risk tier: Prohibited AI practices | Ниво на риск: забранени практики в областта на ИИ | Art.5 | Prohibited AI practices | Забранени практики в областта на ИИ | Chapter III | High-risk AI systems<br>Risk tier: High-risk AI systems | Високорискови системи с ИИ<br>Ниво на риск: високорискови системи с ИИ |
| Art.9 | Risk management system<br>Risk management system for high-risk AI | Система за управление на риска<br>Система за управление на риска за високорискови системи с ИИ | Art.10 | Data and data governance | Данни и администриране на данните | Art.11 | Technical documentation | Техническа документация |
| Annex IV | Annex IV technical documentation | Техническа документация по приложение IV | Art.12 | Record-keeping | Поддържане на регистри | Art.13 | Transparency and information to deployers | Прозрачност и предоставяне на информация на внедрителите |
| Art.14 | Human oversight | Човешки контрол | Art.15 | Accuracy, robustness and cybersecurity | Точност, надеждност и киберсигурност | Art.16 | Obligations of providers | Задължения на доставчиците |
| Art.17 | Quality management system | Система за управление на качеството | Art.26 | Obligations of deployers | Задължения на внедрителите | Art.27 | Fundamental rights impact assessment | Оценка на въздействието върху основните права |
| Chapter IV | Limited-risk (transparency obligations)<br>Risk tier: Limited-risk (transparency obligations) | Ограничен риск (задължения за прозрачност)<br>Ниво на риск: ограничен риск (задължения за прозрачност) | Art.50 | Transparency obligations for certain AI systems | Задължения за прозрачност за определени системи с ИИ | Chapter V | General-purpose AI models<br>Risk tier: General-purpose AI models | Модели на ИИ с общо предназначение<br>Ниво на риск: модели на ИИ с общо предназначение |
| Art.53 | Obligations for providers of GPAI models | Задължения на доставчиците на модели на ИИ с общо предназначение | Art.55 | Obligations for GPAI models with systemic risk | Задължения за модели на ИИ с общо предназначение, пораждащи системен риск | — (see Art.95) | Minimal-risk AI systems<br>Risk tier: Minimal-risk AI systems | Системи с ИИ с минимален риск<br>Ниво на риск: системи с ИИ с минимален риск |
| Art.95 | Codes of conduct (voluntary) | Кодекси за поведение (доброволни) |  |  |  |  |  |  |

Notes. Chapter II: „Ниво на риск“ = the interface word for "risk tier"; Art.10: „администриране“, not „управление“; Art.14: not „надзор“; Art.15: robustness = надеждност here; Art.16: The source drops "of high-risk AI systems"; Chapter IV: „ограничен риск“ is not a term of the Regulation; Art.53: GPAI is written out; — (see Art.95): „минимален риск“ is not a term of the Regulation.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| EU AI Act | Акт за изкуствения интелект на ЕС | EU AI Act (2024/1689) | Акт за изкуствения интелект на ЕС (2024/1689) | Automatic event logging and record-keeping | Автоматично записване на събития и поддържане на регистри |
| Training, validation and testing data governance | Администриране на обучителните, валидационните и изпитвателните данни | Transparency and instructions for use | Прозрачност и инструкции за употреба | Human oversight design and operator competence | Проектиране на човешкия контрол и компетентност на упражняващите го лица |
| Human Oversight & Transparency | Човешки контрол и прозрачност | Provider conformity: assessment, CE marking, declaration and registration | Съответствие при доставчика: оценяване, маркировка „CE“, декларация и регистрация | Deployer operating obligations | Задължения на внедрителя при използването |
| GPAI provider obligations: documentation, downstream information and copyright | Задължения на доставчиците на модели на ИИ с общо предназначение: документация, информация за доставчиците надолу по веригата и авторско право | Systemic-risk GPAI: evaluation, adversarial testing, incident reporting and model security | Модели на ИИ с общо предназначение, пораждащи системен риск: оценка, състезателно изпитване, докладване на инциденти и сигурност на модела |  |  |

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| AI Governance & Accountability | Управление на ИИ и отчетност | AI Risk & Impact Assessment | Оценка на риска и въздействието на ИИ | Access, Infrastructure & Deployment Security | Сигурност на достъпа, инфраструктурата и внедряването |
| Input, Output & Model Behavior Security | Сигурност на входящите данни, резултатите и поведението на модела | Monitoring, Incident Response & Improvement | Наблюдение, реакция при инциденти и подобряване | Training Data & Model Supply Chain | Обучителни данни и верига на доставки на модели |

Vocabulary: conformity assessment = оценяване на съответствието; CE marking = маркировка „CE“; placing on the market = пускане на пазара; instructions for use = инструкции за употреба; serious incident = сериозен инцидент; post-market monitoring = мониторинг след пускането на пазара; systemic risk = системен риск; logs = записи; fundamental rights = основни права.
### eu-uas-ops
The four words that decide this family: UAS = „БЛС“; operation(s) = „експлоатация“ (never „операции“); "open" category = „неограничена“ (never „отворена“); standard scenario = „основен сценарий“ (never „стандартен“). safety = безопасност, security = сигурност: two different things here. Codes are copied: UAS.OPEN.020, STS-01, A1, C2, LUC, VLOS, BVLOS, MTOM, SORA, PDRA, U-space, and the section letters "A." to "K.". "Regulation (EU) 2019/947" = „Регламент (ЕС) 2019/947“.

| Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading |
|---|---|---|---|---|---|---|---|---|
| Art.3 | Categories of UAS operations | Категории експлоатация на БЛС | Art.4 | 'Open' category of UAS operations | „Неограничена“ категория експлоатация на БЛС | Art.5 | 'Specific' category of UAS operations | „Специфична“ категория експлоатация на БЛС |
| Art.8 | Rules and procedures for the competency of remote pilots | Правила и процедури за правоспособността на дистанционно управляващите пилоти | Art.9 | Minimum age for remote pilots | Минимална възраст на дистанционно управляващите пилоти | Art.10 | Rules and procedures for the airworthiness of UAS | Правила и процедури за летателната годност на БЛС |
| Art.11 | Rules for conducting an operational risk assessment | Правила за извършване на оценка на експлоатационния риск | Art.12 | Authorising operations in the 'specific' category | Разрешаване на експлоатация в „специфичната“ категория | Art.13 | Cross-border operations or operations outside the state of registration | Трансгранична експлоатация или експлоатация извън държавата на регистрация |
| Art.14 | Registration of UAS operators and certified UAS | Регистрация на оператори на БЛС и сертифицирани БЛС | Art.15 | Operational conditions for UAS geographical zones | Експлоатационни условия за географските зони на БЛС | Art.19 | Safety information | Информация относно безопасността |
| Art.20 | Particular provisions concerning the use of certain UAS in the 'open' category | Конкретни разпоредби, свързани с използването на определени БЛС в „неограничената“ категория | Annex, Part A | Open category<br>B. Open category | Неограничена категория<br>B. Неограничена категория | UAS.OPEN.010 | General provisions | Общи разпоредби |
| UAS.OPEN.020 | UAS operations in subcategory A1<br>Open: subcategory A1<br>C. Open: subcategory A1 | Експлоатация на БЛС в подкатегория A1<br>Неограничена: подкатегория A1<br>C. Неограничена: подкатегория A1 | UAS.OPEN.030 | UAS operations in subcategory A2<br>Open: subcategory A2<br>D. Open: subcategory A2 | Експлоатация на БЛС в подкатегория A2<br>Неограничена: подкатегория A2<br>D. Неограничена: подкатегория A2 | UAS.OPEN.040 | UAS operations in subcategory A3<br>Open: subcategory A3<br>E. Open: subcategory A3 | Експлоатация на БЛС в подкатегория A3<br>Неограничена: подкатегория A3<br>E. Неограничена: подкатегория A3 |
| UAS.OPEN.050 | Responsibilities of the UAS operator | Отговорности на оператора на БЛС | UAS.OPEN.060 | Responsibilities of the remote pilot | Отговорности на дистанционно управляващия пилот | UAS.OPEN.070 | Duration and validity of the remote pilot online theoretical competency and certificates of remote pilot competency | Срок и валидност на получената онлайн теоретична компетентност на дистанционно управляващия пилот и на неговото свидетелство за правоспособност |
| Annex, Part B | Specific category<br>F. Specific category | Специфична категория<br>F. Специфична категория | UAS.SPEC.020 | Operational declaration | Декларация за експлоатация | Annex, Appendix 1 | Specific: standard scenario declarations<br>G. Specific: standard scenario declarations | Специфична: декларации по основен сценарий<br>G. Специфична: декларации по основен сценарий |
| UAS.SPEC.030 | Application for an operational authorisation | Заявление за разрешение за експлоатация | UAS.SPEC.040 | Issuing of an operational authorisation | Издаване на разрешение за експлоатация | UAS.SPEC.070 | Transferability of an operational authorisation | Прехвърляне на разрешението за експлоатация |
| UAS.SPEC.080 | Duration and validity of an operational authorisation | Срок и валидност на разрешението за експлоатация | UAS.SPEC.085 | Duration and validity of an operational declaration | Срок и валидност на декларацията за експлоатация | UAS.SPEC.090 | Access | Достъп |
| UAS.SPEC.100 | Use of certified equipment and certified unmanned aircraft | Използване на сертифицирано оборудване и сертифицирани безпилотни въздухоплавателни средства | Art.3(b), Art.12 | Specific: operational authorisation<br>J. Specific: operational authorisation | Специфична: разрешение за експлоатация<br>J. Специфична: разрешение за експлоатация | Annex, Part C | Specific: light UAS operator certificate (LUC)<br>K. Specific: light UAS operator certificate (LUC)<br>Specific category: light UAS operator certificate (LUC) | Специфична: удостоверение за оператор на лека БЛС (LUC)<br>K. Специфична: удостоверение за оператор на лека БЛС (LUC)<br>Специфична категория: удостоверение за оператор на лека БЛС (LUC) |
| UAS.LUC.010 | General requirements for an LUC | Общи изисквания за LUC | UAS.LUC.020 | Responsibilities of the LUC holder | Отговорности на притежателя на LUC | UAS.LUC.030 | Safety management system | Система за управление на безопасността |
| UAS.LUC.040 | LUC manual | Ръководство относно LUC | UAS.LUC.050 | Terms of approval of the LUC holder | Условия на одобрението на притежателя на LUC | UAS.LUC.060 | Privileges of the LUC holder | Права на притежателя на LUC |
| UAS.LUC.070 | Changes in the LUC management system | Промени в системата за управление на LUC | UAS.LUC.075 | Transferability of an LUC | Прехвърляне на LUC | UAS.LUC.080 | Duration and validity of an LUC | Срок и валидност на LUC |
| Appendix 1, Chapter I | Specific: STS-01<br>H. Specific: STS-01 | Специфична: STS-01<br>H. Специфична: STS-01 | UAS.STS-01.020 | UAS operations in STS-01 | Експлоатация на БЛС съгласно STS-01 | Appendix 1, Chapter II | Specific: STS-02<br>I. Specific: STS-02 | Специфична: STS-02<br>I. Специфична: STS-02 |
| UAS.STS-02.020 | UAS operations in STS-02 | Експлоатация на БЛС съгласно STS-02 | UAS.STS-02.050 | Responsibilities of the airspace observer | Отговорности на наблюдателя на въздушното пространство | Regulation (EU) 2021/664, Art. 6 | Obligations of UAS operators in U-space airspace (Regulation (EU) 2021/664) | Задължения на операторите на БЛС във въздушното пространство U-space (Регламент (ЕС) 2021/664) |

Notes. UAS.OPEN.010: Same at UAS.SPEC.010, UAS.STS-01.010, UAS.STS-02.010; UAS.OPEN.050: Same at UAS.SPEC.050, UAS.STS-01.030, UAS.STS-02.030; UAS.OPEN.060: Same at UAS.SPEC.060, UAS.STS-01.040, UAS.STS-02.040; Annex, Part C: „удостоверение“ (Part C title), not „свидетелство“.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| EU Drone Operations (Regulation (EU) 2019/947) | Експлоатация на дронове в ЕС (Регламент (ЕС) 2019/947) | Class C2 drone: open category A2 and A3 | Дрон от клас C2: неограничена категория A2 и A3 | Every operation<br>A. Every operation | Всяка експлоатация<br>A. Всяка експлоатация |
| Open category A1: over people (class C0, C1)<br>Open category A2: close to people (class C2)<br>Open category A3: far from people (class C2, C3, C4) | Неограничена категория A1: над хора (клас C0, C1)<br>Неограничена категория A2: близо до хора (клас C2)<br>Неограничена категория A3: далеч от хора (клас C2, C3, C4) | Specific category STS-01: VLOS over a populated area (class C5)<br>Specific category STS-02: BVLOS over a sparsely populated area (class C6) | Специфична категория STS-01: VLOS в населена среда (клас C5)<br>Специфична категория STS-02: BVLOS в слабо населена среда (клас C6) | Specific category: operational authorisation (SORA or PDRA) | Специфична категория: разрешение за експлоатация (SORA или PDRA) |
| Operational risk assessment under Article 11 (SORA or PDRA) | Оценка на експлоатационния риск по член 11 (SORA или PDRA) | A2 certificate of remote pilot competency | Свидетелство за правоспособност на дистанционно управляващ пилот за A2 | Accountable manager, safety policy and safety personnel | Отговорен управител, политика на безопасност и персонал по безопасността |
| Aircraft eligible for subcategory A1<br>Aircraft eligible for subcategory A3 | Въздухоплавателни средства, допустими за подкатегория A1<br>Въздухоплавателни средства, допустими за подкатегория A3 | Geographical zone information, conditions and permissions | Информация, условия и разрешения за географските зони | Remote identification and geo-awareness active and updated | Активни и актуализирани идентификация от разстояние и геопространствено ориентиране |
| Involved persons informed of the risks and consenting (A2 and A3) | Участващи лица, осведомени за рисковете и дали съгласие (A2 и A3) | Occurrence reporting and follow-up | Докладване на събития и последващи действия | Operations manual and emergency response plan for authorised operations<br>Operations manual and emergency response plan for standard scenarios | Ръководство за експлоатация и план за реагиране при извънредни ситуации за разрешена експлоатация<br>Ръководство за експлоатация и план за реагиране при извънредни ситуации за основни сценарии |
| STS-01 operational volume, ground risk buffer and controlled ground area<br>STS-02 operational volume, ground risk buffer and controlled ground area | STS-01 оперативен обем, буфер за наземен риск и контролирана наземна площ<br>STS-02 оперативен обем, буфер за наземен риск и контролирана наземна площ | STS-02 airspace observers and visibility | STS-02 наблюдатели на въздушното пространство и видимост | STS-01 class C5 aircraft and flight termination<br>STS-02 class C6 aircraft, flight-geography limitation and flight termination | STS-01 въздухоплавателно средство от клас C5 и прекратяване на полета<br>STS-02 въздухоплавателно средство от клас C6, ограничаване до географията на полета и прекратяване на полета |
| STS-01 remote pilot flight duties | STS-01 задължения на дистанционно управляващия пилот по време на полета | Standard-scenario theoretical certificate and practical-skill accreditation | Свидетелство за теоретични познания и акредитация за практическо обучение по основните сценарии | Category and subcategory decided before each operation is planned | Категория и подкатегория, определени преди планирането на всяка експлоатация |
| Class C2 aircraft configured for subcategory A2 | Въздухоплавателно средство от клас C2, конфигурирано за подкатегория A2 | Class label, declaration of conformity and modification control | Етикет за класа, декларация за съответствие и контрол на измененията | Horizontal distance from uninvolved persons in subcategory A2 | Хоризонтално разстояние до неучастващи лица в подкатегория A2 |
| Overflight limits in subcategory A1 | Ограничения за прелитане в подкатегория A1 | Operating areas selected for subcategory A3 | Избор на зони за експлоатация в подкатегория A3 | Remote pilot competency for subcategory A1<br>Remote pilot competency for subcategory A3 | Компетентност на дистанционно управляващия пилот за подкатегория A1<br>Компетентност на дистанционно управляващия пилот за подкатегория A3 |
| Open-category competency validity and revalidation | Валидност и потвърждаване на валидността на компетентността в неограничената категория | Open-category procedures, flight assignment and support personnel | Процедури, определяне на пилот за всеки полет и поддържащ персонал в неограничената категория | Pre-flight checks and flight conduct in the open category | Предполетни проверки и изпълнение на полета в неограничената категория |
| Operator registration and registration number on every aircraft | Регистрация на оператора и регистрационен номер на всяко въздухоплавателно средство | Fleet register with each aircraft's conformity basis | Регистър на флота с основанието за съответствие на всяко въздухоплавателно средство | Remote pilot roster with credentials, expiry and age | Списък на дистанционно управляващите пилоти със свидетелства, срок на валидност и възраст |
| Maintenance, firmware and payload configuration to the manufacturer's instructions | Техническо обслужване, фърмуер и конфигурация на полезния товар според инструкциите на производителя | National requirements and insurance for each State of operation | Национални изисквания и застраховане за всяка държава на експлоатация | Personal data captured by aircraft sensors | Лични данни, заснети от сензорите на въздухоплавателното средство |
| Specific-category procedures, limitations and mitigation review | Процедури, ограничения и преглед на мерките за смекчаване на риска в специфичната категория | Competency-based training for remote pilots and essential personnel | Обучение по компетентности за дистанционно управляващите пилоти и персонала със задължения от съществено значение | Three-year records of personnel, maintenance and operations | Тригодишен регистър за персонала, техническото обслужване и експлоатацията |
| Maintenance programme, maintenance staff and certified equipment | Програма за техническо обслужване, персонал по техническото обслужване и сертифицирано оборудване | Remote pilot duties before and during specific-category flights | Задължения на дистанционно управляващия пилот преди и по време на полети в специфичната категория | Operations in another Member State | Експлоатация в друга държава членка |
| Competent-authority access and oversight readiness | Достъп на компетентния орган и готовност за надзор | Operational authorisation application and scope<br>Authorisation conditions, changes and validity | Заявление за разрешение за експлоатация и обхват<br>Условия, промени и валидност на разрешението | LUC application, terms of approval and privileges<br>LUC records and continuing validity | Заявление за LUC, условия на одобрението и права<br>Записи за LUC и запазване на валидността |
| Standard-scenario declaration, confirmation and two-year validity | Декларация по основен сценарий, потвърждение и двугодишна валидност | Safety risk management, safety reporting and management of change | Управление на риска за безопасността, докладване относно безопасността и управление на промените | Independent compliance monitoring, subcontractors and authority access | Независимо наблюдение на спазването на изискванията, подизпълнители и достъп на органа |
| Operational control and self-authorisation of operations | Експлоатационен контрол и самостоятелно разрешаване на експлоатацията | U-space airspace services and flight authorisation requests | Обслужване за U-space и искания за разрешение за полет | Security of the operation and protection against unlawful interference | Сигурност на експлоатацията и защита от незаконна намеса |

Vocabulary: UAS operator = оператор на БЛС; unmanned aircraft = безпилотно въздухоплавателно средство; subcategory = подкатегория; class = клас; LUC holder = притежател на LUC; operations manual = ръководство за експлоатация; safety management system = система за управление на безопасността; maintenance = техническо обслужване; competency = правоспособност (Art. 8) / компетентност (Annex); uninvolved persons = неучастващи лица; competent authority = компетентен орган; Member State = държава членка.
### finos-aigf
"MI-n" / "RI-n" codes are copied. Preventative mitigations = Превантивни мерки за смекчаване; Detective mitigations = Откриващи мерки за смекчаване.

- acceptance criteria = критерии за приемане; AI firewall = защитна стена за ИИ; alerting = сигнализиране; citations and source traceability = цитирания и проследимост на източниците; credential discovery and harvesting = откриване и събиране на идентификационни данни; data quality and drift = качество и дрейф на данните; Denial of Wallet (DoW) = Denial of Wallet (DoW); hosted model = хостван модел; human feedback loop = цикъл на обратна връзка от хора; human-in-the-loop action approval gate = одобрение на действия с участието на човек; inadequate system alignment = недостатъчна съгласуваност на системата; intellectual property (IP) and copyright = интелектуална собственост и авторско право; model overreach / expanded use = излизане на модела извън предназначението / разширена употреба;
- non-deterministic behaviour = недетерминирано поведение; Quality of Service (QoS) = качество на услугата (QoS); recertified = пресертифициран; spend monitoring = наблюдение на разходите; standing secrets = постоянни тайни; state persistence poisoning = отравяне на запазеното състояние; system acceptance testing = приемно тестване на системата; tool chain manipulation = манипулиране на веригата от инструменти.
### gdpr
"GDPR" stays Latin; cite the act as „Регламент (ЕС) 2016/679“. Every heading is an official title: copy it from the table. controller = администратор; processor = обработващ лични данни; processing = обработване; transfer = предаване; breach = нарушение на сигурността на личните данни.

| Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading |
|---|---|---|---|---|---|---|---|---|
| Chapter II | Principles | Принципи | Art.5 | Principles relating to processing of personal data | Принципи, свързани с обработването на лични данни | Art.6 | Lawfulness of processing | Законосъобразност на обработването |
| Art.7 | Conditions for consent | Условия за даване на съгласие | Chapter III | Data Subject Rights | Права на субекта на данни | Art.12 | Transparent information, communication and modalities for the exercise of the rights of the data subject | Прозрачна информация, комуникация и условия за упражняването на правата на субекта на данни |
| Art.13 | Information to be provided where personal data are collected from the data subject | Информация, предоставяна при събиране на лични данни от субекта на данните | Art.14 | Information to be provided where personal data have not been obtained from the data subject | Информация, предоставяна, когато личните данни не са получени от субекта на данните | Art.15 | Right of access by the data subject | Право на достъп на субекта на данните |
| Art.16 | Right to rectification | Право на коригиране | Art.17 | Right to erasure ('right to be forgotten') | Право на изтриване (право „да бъдеш забравен“) | Art.18 | Right to restriction of processing | Право на ограничаване на обработването |
| Art.19 | Notification obligation regarding rectification or erasure of personal data or restriction of processing | Задължение за уведомяване при коригиране или изтриване на лични данни или ограничаване на обработването | Art.20 | Right to data portability | Право на преносимост на данните | Art.21 | Right to object | Право на възражение |
| Art.22 | Automated individual decision-making, including profiling | Автоматизирано вземане на индивидуални решения, включително профилиране | Chapter IV | Controller & Processor | Администратор и обработващ лични данни | Art.25 | Data protection by design and by default | Защита на данните на етапа на проектирането и по подразбиране |
| Art.28 | Processor | Обработващ личните данни | Art.30 | Records of processing activities | Регистри на дейностите по обработване | Art.32 | Security of processing | Сигурност на обработването |
| Art.33 | Notification of a personal data breach to the supervisory authority | Уведомяване на надзорния орган за нарушение на сигурността на личните данни | Art.34 | Communication of a personal data breach to the data subject | Съобщаване на субекта на данните за нарушение на сигурността на личните данни | Art.35 | Data protection impact assessment | Оценка на въздействието върху защитата на данните |
| Chapter V | International Transfers | Международно предаване на данни | Art.44 | General principle for transfers | Общ принцип на предаването на данни | Art.45 | Transfers on the basis of an adequacy decision | Предаване на данни въз основа на решение относно адекватното ниво на защита |
| Art.46 | Transfers subject to appropriate safeguards | Предаване на данни с подходящи гаранции | Art.47 | Binding corporate rules | Задължителни фирмени правила | Art.48 | Transfers or disclosures not authorised by Union law | Предаване или разкриване на данни, което не е разрешено от правото на Съюза |
| Art.49 | Derogations for specific situations | Дерогации в особени случаи |  |  |  |  |  |  |

Notes. Art.14: Title as corrected on 23.5.2018; Art.28: The title has the definite „личните“; the defined term is „обработващ лични данни“; Chapter V: Paraphrase of the chapter title; „предаване“, never „трансфер“.

Vocabulary for other families that touch the GDPR: supervisory authority = надзорен орган; data protection officer = длъжностно лице по защита на данните; data protection impact assessment = оценка на въздействието върху защитата на данните; pseudonymisation = псевдонимизация; profiling = профилиране; legitimate interests = легитимни интереси; purpose limitation = ограничение на целите; data minimisation = свеждане на данните до минимум; storage limitation = ограничение на съхранението; third country = трета държава; without undue delay = без ненужно забавяне; sub-processor = подизпълнител.
### generic
Risk titles, noun phrases.

| English | Bulgarian | English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|---|---|
| Backup Failure | Неуспешно резервно копиране | Business Email Compromise | Компрометиране на служебна електронна поща | Cloud Misconfiguration | Неправилна облачна конфигурация | Data Breach via SQL Injection | Нарушение на сигурността на данните чрез SQL инжектиране |
| DDoS Service Disruption | Прекъсване на услугата от DDoS атака | GDPR Non-Compliance | Несъответствие с GDPR | Insider Data Theft | Кражба на данни от вътрешно лице | Key Personnel Departure | Напускане на ключов персонал |
| License Violation | Нарушение на лицензионни условия | Natural Disaster Impact | Въздействие на природно бедствие | Phishing Attack Compromise | Компрометиране чрез фишинг атака | Physical Server Room Intrusion | Физическо проникване в сървърното помещение |
| Ransomware Infection | Заразяване със софтуер за откуп | Third-Party Vendor Breach | Пробив при външен доставчик | Unpatched Known Vulnerability Exploited | Експлоатирана известна уязвимост без приложена корекция | Weak Access Controls | Слаб контрол на достъпа |
### imda-mgf
"Model" in the name means "exemplary" and is not translated. Dimension headings keep the code: „D1 Ограничете рисковете предварително“, „D2 Реална човешка отчетност“, „D3 Технически контроли и процеси“, „D4 Отговорност на крайния потребител“.

- accountable human owner = отговорен собственик човек; decision class = клас решения; disclosure that an AI agent is in use = оповестяване, че се използва ИИ агент; failure modes = режими на отказ; human involvement model = модел на човешко участие; inter-agent communication and delegation = комуникация и делегиране между агенти; intervention, escalation and stop authority = правомощия за намеса, ескалация и спиране; redress channels = канали за защита и обезщетение; risk taxonomy and tolerances = таксономия на рисковете и толерантност към риска; scope and authority limits = обхват и лимити на правомощията.
### internal-controls
Noun phrases; ids "IC-136" are copied. Patterns for "X Compliance / Control / Management / Verification" are in the statement-pattern table. "Internal Control Library" = „Библиотека с вътрешни контроли“.

- BCMS = BCMS; business continuity exercise programme = програма за учения по непрекъснатост на дейността; Centralized AAA Management = Централизирано управление на AAA; ICS/OT Security = Сигурност на ICS/OT; ICT continuity readiness = готовност на ИКТ за непрекъснатост; inquiry and complaints resolution = разглеждане на запитвания и жалби; ISMS Review and Monitoring = Преглед и наблюдение на СУСИ; off-premises asset = актив извън територията на организацията; payment card data = данни за платежни карти; POI device inspection = проверка на POI устройства; response team = екип за реакция; script allowlisting = разрешителен списък за скриптове; special interest groups = групи със специални интереси; warning and communication procedures = процедури за предупреждение и комуникация.
### iso-27001
ISMS = СУСИ. Three kinds of heading, told apart by the item's `file`:
1. `iso27001-control-templates.json` (`title`, id "5.9"): the official control title. Copy it from the table.
2. `iso27001-2022.yaml` (`name`, id "A.5.9"): the product's short name of the same control. Shorten the official title the way the source does, with the same words („Опис на информационните активи“, „Защита срещу зловреден софтуер“, „Планиране на управлението на инциденти“). Clause names (id "4" … "10") are in the iso-clauses table.
3. `iso27001_2022_annexA.json` (`title`, id "5.9") and the demo titles: the product's plain-language title ("A current register of assets and their owners"). Core vocabulary: „информационна сигурност“, „тестване“, „осведоменост“.

Themes: Organizational / People / Physical / Technological Controls = „Организационни контроли“ / „Контроли за хората“ / „Физически контроли“ / „Технологични контроли“. Official titles by control number (the number is in the item `id`: "5.9", "A.5.9"); БДС vocabulary: „сигурност на информацията“, „изпитване“, „осъзнаване“, „проучване“, „реагиране“:

| # | Official Bulgarian title | # | Official Bulgarian title | # | Official Bulgarian title | # | Official Bulgarian title | # | Official Bulgarian title |
|---|---|---|---|---|---|---|---|---|---|
| 5.1 | Политики за сигурност на информацията | 5.2 | Роли и отговорности, свързани със сигурността на информацията | 5.3 | Разделяне на задълженията | 5.4 | Отговорности на ръководството | 5.5 | Контакт с органи на властта |
| 5.6 | Контакт с групи със специални интереси | 5.7 | Разузнавателни сведения за заплахи | 5.8 | Сигурност на информацията при управление на проекти | 5.9 | Опис на информацията и други свързани с нея активи | 5.10 | Приемливо използване на информацията и други свързани с нея активи |
| 5.11 | Връщане на активи | 5.12 | Класификация на информацията | 5.13 | Маркиране на информацията | 5.14 | Пренос на информация | 5.15 | Контрол на достъпа |
| 5.16 | Управление на идентичността | 5.17 | Информация за удостоверяване | 5.18 | Права за достъп | 5.19 | Сигурност на информацията при взаимоотношения с доставчици | 5.20 | Разглеждане на сигурността на информацията в споразуменията с доставчици |
| 5.21 | Управление на сигурността на информацията във веригата за доставки на ИКТ | 5.22 | Наблюдение, преглед и управление на промените в услугите на доставчици | 5.23 | Сигурност на информацията при използване на услуги в облак | 5.24 | Планиране и подготовка на управлението на инциденти, свързани със сигурността на информацията | 5.25 | Оценяване и вземане на решения за събития, свързани със сигурността на информацията |
| 5.26 | Реагиране при инциденти, свързани със сигурността на информацията | 5.27 | Извличане на поуки от инциденти, свързани със сигурността на информацията | 5.28 | Събиране на доказателства | 5.29 | Сигурност на информацията по време на прекъсване | 5.30 | Готовност на ИКТ за непрекъснатост на дейността |
| 5.31 | Правни, нормативни, регулаторни и договорни изисквания | 5.32 | Права върху интелектуална собственост | 5.33 | Защита на записи | 5.34 | Неприкосновеност и защита на PII | 5.35 | Независим преглед на сигурността на информацията |
| 5.36 | Съответствие с политиките, правилата и стандартите за сигурност на информацията | 5.37 | Документирани оперативни процедури | 6.1 | Проучване | 6.2 | Условия за наемане на работа | 6.3 | Осъзнаване, образование и обучение по сигурност на информацията |
| 6.4 | Дисциплинарен процес | 6.5 | Отговорности след прекратяване или промяна на трудовото правоотношение | 6.6 | Споразумения за поверителност или неразкриване | 6.7 | Работа от разстояние | 6.8 | Докладване на събития, свързани със сигурността на информацията |
| 7.1 | Физически периметри на сигурност | 7.2 | Физически достъп | 7.3 | Осигуряване на сигурността на офиси, помещения и съоръжения | 7.4 | Наблюдение на физическата сигурност | 7.5 | Защита срещу физически заплахи и заплахи от околната среда |
| 7.6 | Работа в зони за сигурност | 7.7 | Чисто бюро и чист екран | 7.8 | Разполагане и защита на оборудването | 7.9 | Сигурност на активите извън територията на организацията | 7.10 | Носители за съхранение |
| 7.11 | Поддържащи комунални услуги | 7.12 | Сигурност на окабеляването | 7.13 | Поддръжка на оборудването | 7.14 | Сигурно извеждане от употреба или повторно използване на оборудване | 8.1 | Крайни устройства на потребителите |
| 8.2 | Привилегировани права за достъп | 8.3 | Ограничаване на достъпа до информация | 8.4 | Достъп до изходен код | 8.5 | Сигурно удостоверяване | 8.6 | Управление на капацитета |
| 8.7 | Защита срещу зловреден софтуер | 8.8 | Управление на технически уязвимости | 8.9 | Управление на конфигурацията | 8.10 | Изтриване на информация | 8.11 | Маскиране на данни |
| 8.12 | Предотвратяване на изтичане на данни | 8.13 | Резервни копия на информацията | 8.14 | Резервираност на средствата за обработване на информация | 8.15 | Записване на събития | 8.16 | Дейности по наблюдение |
| 8.17 | Синхронизиране на часовниците | 8.18 | Използване на привилегировани помощни програми | 8.19 | Инсталиране на софтуер на системи в експлоатация | 8.20 | Сигурност на мрежите | 8.21 | Сигурност на мрежовите услуги |
| 8.22 | Разделяне на мрежите | 8.23 | Уеб филтриране | 8.24 | Използване на криптография | 8.25 | Жизнен цикъл на сигурното разработване | 8.26 | Изисквания за сигурност на приложенията |
| 8.27 | Сигурна архитектура на системите и принципи за проектиране | 8.28 | Сигурно програмиране | 8.29 | Изпитване на сигурността при разработване и приемане | 8.30 | Разработване, възложено на външни изпълнители | 8.31 | Разделяне на средите за разработване, изпитване и експлоатация |
| 8.32 | Управление на промените | 8.33 | Информация за изпитване | 8.34 | Защита на информационните системи по време на одитни изпитвания |  |  |  |  |

Also: "Threat intelligence programme" = „Програма за разузнавателни сведения за заплахи“; "Anti-malware controls" = „Контроли срещу зловреден софтуер“.
### iso-27701
PIMS = PIMS (система за управление на неприкосновеността на информацията). PII stays „PII“; never „лични данни“ in this family. Ids "PIMS-02" are copied.

- PII principal = субект на PII; PII controller / joint PII controller = администратор на PII / съвместен администратор на PII; PII processor = обработващ PII; subcontractor, sub-processor = подизпълнител; customer (of a processor) = клиент („Споразумение с клиента“, „PII на клиента“); instruction (of the customer) = нареждане („Нареждане в нарушение на законодателството“); request (of a principal) = искане; conditions for collection and processing = условия за събиране и обработване; obligations to PII principals = задължения към субектите на PII; privacy by design and by default = неприкосновеност на етапа на проектирането и по подразбиране; PII sharing, transfer and disclosure = споделяне, предаване и разкриване на PII;
- mechanism to modify or withdraw consent = механизъм за промяна или оттегляне на съгласието; mechanism to object to processing = механизъм за възражение срещу обработването; access, correction and erasure = достъп, коригиране и изтриване; automated decision making = автоматизирано вземане на решения; PII minimization objectives = цели за свеждане на PII до минимум; de-identification and deletion at end of processing = деидентификация и изтриване в края на обработването; PII Retained Beyond Purpose = PII, съхранявана след отпадане на целта; return, transfer or disposal of PII = връщане, предаване или унищожаване на PII; PII transmission controls = контроли при пренос на PII; transfer between jurisdictions / cross-border transfer = предаване между юрисдикции / трансгранично предаване;
- countries and organizations PII may be transferred to = държави и организации, на които може да се предава PII; records of PII disclosure to third parties = записи за разкриване на PII на трети страни; notification of disclosure requests = уведомяване за искания за разкриване; disclosure of subcontractors = оповестяване на подизпълнителите; engagement / change of a subcontractor = ангажиране / смяна на подизпълнител; privacy impact assessment = оценка на въздействието върху неприкосновеността; PIMS-specific requirements (extends the ISMS) = специфични за PIMS изисквания (разширяват СУСИ); PIMS-specific guidance (extends the controls) = специфични за PIMS указания (разширяват контролите); PII controller guidance (Annex A) = указания за администратори на PII (приложение A);
- PII processor guidance (Annex B) = указания за обработващи PII (приложение B); PIMS Management = Управление на PIMS; Consent Management = Управление на съгласията.
### iso-42001
AIMS = AIMS (система за управление на ИИ). Clause-level headings are the product's imperatives: „Създайте политика за ИИ“, „Определете обхвата на системата за управление на ИИ“, „Провеждайте вътрешни одити на AIMS“, „Проведете преглед от ръководството на AIMS“. "Clause 7 Support" = „Точка 7 Поддържане“ (no separator in the source, none in the output). Clause names: see iso-clauses.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| A.2 Policies related to AI | A.2 Политики, свързани с ИИ | A.3 Internal organization | A.3 Вътрешна организация | A.4 Resources for AI systems | A.4 Ресурси за системи с ИИ |
| A.5 Assessing impacts of AI systems | A.5 Оценка на въздействията на системи с ИИ | A.6 AI system life cycle | A.6 Жизнен цикъл на системата с ИИ | A.7 Data for AI systems | A.7 Данни за системи с ИИ |
| A.8 Information for interested parties | A.8 Информация за заинтересованите страни | A.9 Use of AI systems | A.9 Използване на системи с ИИ | A.10 Third-party and customer relationships | A.10 Взаимоотношения с трети страни и клиенти |

- AI objectives = цели за ИИ; AI risk assessment / treatment = оценка / третиране на риска, свързан с ИИ; AI system impact assessment = оценка на въздействието на системата с ИИ; AI risks and opportunities = рискове и възможности, свързани с ИИ; responsible development / use = отговорно разработване / използване; scope creep from the intended purpose = разширяване извън предназначението; societal impacts = въздействия върху обществото; functional and non-functional requirements = функционални и нефункционални изисквания; verification and validation = проверка и валидиране; dataset provenance = произход на наборите от данни; tooling = инструментариум; accountability across the AI supply chain = отчетност по веригата за доставки на ИИ; mechanism for reporting concerns = механизъм за подаване на сигнали;
- needs and expectations of interested parties = потребности и очаквания на заинтересованите страни.
### iso-clauses
ISO 9001 (QMS = СУК), ISO 28000, ISO 39001 (RTS = БДП); the clause names of ISO/IEC 27001 and 42001 use the same words. "Clause N - Title" = „Точка N - Заглавие“. БДС wording:

| Clause | Bulgarian | Clause | Bulgarian | Clause | Bulgarian | Clause | Bulgarian |
|---|---|---|---|---|---|---|---|
| 4 Context of the organization | Контекст на организацията | 4.1 Understanding the organization and its context | Разбиране на организацията и нейния контекст | 4.2 Understanding the needs and expectations of interested parties | Разбиране на потребностите и очакванията на заинтересованите страни | 4.3 Determining the scope of the QMS | Определяне на обхвата на СУК |
| 4.3 Determining the scope of the security management system | Определяне на обхвата на системата за управление на сигурността | 4.3 Determining the scope of the RTS management system | Определяне на обхвата на системата за управление на БДП | 4.4 QMS and its processes | СУК и нейните процеси | 4.4 Security management system | Система за управление на сигурността |
| 4.4 Road traffic safety management system | Система за управление на безопасността на движението по пътищата | 5 Leadership | Лидерство | 5.1 Leadership and commitment | Лидерство и ангажираност | 5.1.2 Customer focus | Насоченост към клиента |
| 5.2 Quality policy | Политика по качеството | 5.2 Security management policy | Политика за управление на сигурността | 5.2 RTS policy | Политика по БДП | 5.3 Organizational roles, responsibilities and authorities | Роли, отговорности и пълномощия в организацията |
| 6 Planning | Планиране | 6.1 Actions to address risks and opportunities | Действия за овладяване на рисковете и възможностите | 6.1 Actions to address security risks and opportunities | Действия за овладяване на рисковете и възможностите, свързани със сигурността | 6.2 Quality objectives and planning to achieve them | Цели по качеството и планиране за постигането им |
| 6.2 Security objectives and planning to achieve them | Цели по сигурността и планиране за постигането им | 6.2 RTS performance factors, objectives and targets | Фактори за резултатност, общи и конкретни цели по БДП | 6.3 Planning of changes | Планиране на измененията | 7 Support | Поддържане |
| 7.1 Resources | Ресурси | 7.1.5 Monitoring and measuring resources | Ресурси за наблюдение и измерване | 7.1.6 Organizational knowledge | Знания на организацията | 7.2 Competence | Компетентност |
| 7.3 Awareness | Осъзнаване | 7.4 Communication | Обмен на информация | 7.5 Documented information | Документирана информация | 8 Operation | Функциониране |
| 8.1 Operational planning and control | Оперативно планиране и управление | 8.2 Requirements for products and services | Изисквания за продукти и услуги | 8.2 Security risk assessment | Оценка на риска за сигурността | 8.2 Emergency preparedness and response | Готовност и реагиране при извънредни ситуации |
| 8.3 Security risk treatment | Третиране на риска за сигурността | 8.3 Design and development of products and services | Проектиране и разработване на продукти и услуги | 8.4 Control of externally provided processes, products and services | Управление на външно предоставени процеси, продукти и услуги | 8.4 Supply chain security management | Управление на сигурността на веригата за доставки |
| 8.5 Production and service provision | Производство и предоставяне на услуга | 8.5.1 Control of production and service provision | Управление на производството и предоставянето на услуга | 8.6 Release of products and services | Пускане на продукти и услуги | 8.7 Control of nonconforming outputs | Управление на несъответстващи изходни елементи |
| 9 Performance evaluation | Оценяване на резултатността | 9.1 Monitoring, measurement, analysis and evaluation | Наблюдение, измерване, анализ и оценяване | 9.1.2 Customer satisfaction | Удовлетвореност на клиента | 9.1.3 Analysis and evaluation | Анализ и оценяване |
| 9.2 Internal audit | Вътрешен одит | 9.2 Investigation of road traffic crashes and incidents | Разследване на пътнотранспортни произшествия и инциденти | 9.3 Management review | Преглед от ръководството | 10 Improvement | Подобряване |
| 10.1 General improvement | Подобряване. Общи положения | 10.1 Nonconformity and corrective action | Несъответствие и коригиращо действие | 10.2 Continual improvement | Непрекъснато подобряване |  |  |
### nis2
"NIS2" stays Latin: "NIS2 Directive" = „Директива NIS2“; cite the act as „Директива (ЕС) 2022/2555“. Points of Art. 21(2) have no title: the heading is the wording of the provision. management body = управителен орган; significant incident = значителен инцидент; CSIRT = CSIRT (stays in Latin, as in the interface); incident handling = действия при инцидент.

| Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading | Ref | English heading | Bulgarian heading |
|---|---|---|---|---|---|---|---|---|
| Art. 7 | Article 7 - National cybersecurity strategy | Член 7 - Национална стратегия за киберсигурност | Art. 7(1) | National cybersecurity strategy adoption | Приемане на национална стратегия за киберсигурност | Art. 20 | Article 20 - Governance | Член 20 - Управление |
| Art. 20(1) | Management body approval and oversight of cybersecurity measures | Одобряване и надзор на мерките за киберсигурност от управителните органи | Art. 20(2) | Cybersecurity training for management bodies | Обучение в областта на киберсигурността за управителните органи | Art. 21 | Article 21 - Cybersecurity risk-management measures<br>Article 21 — Cybersecurity Risk-Management Measures | Член 21 - Мерки за управление на риска в областта на киберсигурността<br>Член 21 — Мерки за управление на риска в областта на киберсигурността |
| Art. 21(2)(a) | Policies on risk analysis and information system security | Политики за анализ на риска и сигурност на информационните системи | Art. 21(2)(b) | Incident handling<br>Incident Handling | Действия при инцидент<br>Действия при инцидент | Art. 21(2)(c) | Business continuity and crisis management | Непрекъснатост на стопанската дейност и управление на кризи |
| Art. 21(2)(d) | Supply chain security<br>Supply Chain Security | Сигурност на веригата за доставка<br>Сигурност на веригата за доставка | Art. 21(2)(e) | Security in network and information systems acquisition, development and maintenance | Сигурност при придобиването, разработването и поддръжката на мрежови и информационни системи | Art. 21(2)(f) | Policies and procedures to assess effectiveness of cybersecurity risk-management measures | Политики и процедури за оценяване на ефективността на мерките за управление на риска в областта на киберсигурността |
| Art. 21(2)(g) | Basic cyber hygiene practices and cybersecurity training | Основни киберхигиенни практики и обучение в областта на киберсигурността | Art. 21(2)(h) | Policies and procedures regarding use of cryptography and encryption | Политики и процедури относно използването на криптография и криптиране | Art. 21(2)(i) | Human resources security, access control policies and asset management | Сигурност на човешките ресурси, политики за контрол на достъпа и управление на активи |
| Art. 21(2)(j) | Multi-factor authentication, secured communications and emergency communication systems | Многофакторно удостоверяване на автентичността, защитени съобщения и системи за спешна комуникация | Art. 23 | Article 23 - Reporting obligations<br>Article 23 — Reporting Obligations | Член 23 - Задължения за докладване<br>Член 23 — Задължения за докладване | Art. 23(4)(a)<br>(catalogue id Art.23(1)) | Early warning notification to CSIRT within 24 hours<br>Early warning notification (24h) | Ранно предупреждение до CSIRT в рамките на 24 часа<br>Ранно предупреждение (24 ч) |
| Art. 23(4)(b)<br>(catalogue id Art.23(2)) | Incident notification within 72 hours<br>Incident notification (72h) | Уведомление за инцидент в рамките на 72 часа<br>Уведомление за инцидент (72 ч) | Art. 23(4)(d)<br>(catalogue id Art.23(3)) | Final incident report within one month<br>Final incident report (1 month) | Окончателен доклад за инцидента в срок от един месец<br>Окончателен доклад за инцидента (1 месец) | Art. 24 | Article 24 - Use of certification schemes<br>Use of European cybersecurity certification schemes | Член 24 - Използване на схеми за сертифициране<br>Използване на европейски схеми за сертифициране на киберсигурността |
| Art. 25 | Article 25 - Standardisation | Член 25 - Стандартизация | Art. 25(1) | Use of European or international standards and technical specifications | Използване на европейски и международни стандарти и технически спецификации | Art. 28 | Article 28 - Database of domain name registrations | Член 28 - База данни с регистрационни данни на имена на домейни |
| Art. 28(1) | Domain name registration database accuracy | Точност на базата данни с регистрационни данни на имена на домейни | Art. 29 | Article 29 - Information sharing arrangements | Член 29 - Споразумения за обмен на информация | Art. 29(1) | Voluntary cybersecurity information sharing | Доброволен обмен на информация в областта на киберсигурността |

Notes. Art. 21(2)(b): Not „управление на инциденти“, not „реакция при инциденти“; Art. 21(2)(d): Singular „доставка“ in the article; Art. 23(4)(a): „CSIRT“ (lead decision: the Latin acronym, as in the interface); Art. 24: First: shortened title; second: full title; Art. 25(1): „и“, although the source says "or"; Art. 29: Shortened as in the source.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| NIS2 Directive | Директива NIS2 | NIS2 Directive (EU 2022/2555) | Директива NIS2 (ЕС 2022/2555) | Risk Management Measures | Мерки за управление на риска |
| Reporting<br>Reporting & Notification | Докладване<br>Докладване и уведомяване | Governance & Accountability | Управление и отчетност | Management body cybersecurity oversight | Надзор на киберсигурността от управителния орган |
| Management cybersecurity training | Обучение на управителните органи в областта на киберсигурността | Risk analysis and information security policies | Политики за анализ на риска и информационна сигурност | Incident handling procedures | Процедури за действия при инцидент |
| Supply Chain | Верига за доставка | Cyber Hygiene & Training<br>Cyber hygiene and security training<br>Training | Киберхигиена и обучение<br>Киберхигиена и обучение по сигурност<br>Обучение | Effectiveness assessment of cybersecurity measures<br>Security Assessment<br>Assessment | Оценяване на ефективността на мерките за киберсигурност<br>Оценяване на сигурността<br>Оценяване |
| Cryptography and encryption policies | Политики за криптография и криптиране | HR Security<br>HR security and access control | Сигурност на човешките ресурси<br>Сигурност на човешките ресурси и контрол на достъпа | Authentication & Access Management<br>Multi-factor authentication and secured communications | Удостоверяване на автентичността и управление на достъпа<br>Многофакторно удостоверяване на автентичността и защитени съобщения |
| Development | Разработване | National strategy and CSIRT contact points (Article 7 binds Member States) | Национална стратегия и звена за контакт на CSIRT (член 7 обвързва държавите членки) | Standards adopted to demonstrate compliance (Article 25 binds Member States) | Стандарти, приети за доказване на съответствие (член 25 обвързва държавите членки) |
| Certification-scheme applicability determination (Article 24 is permissive) | Определяне на приложимостта на схемите за сертифициране (член 24 дава възможност, без да задължава) | Information-sharing participation decision (Article 29 is voluntary) | Решение за участие в обмена на информация (член 29 е на доброволна основа) | Domain registration data — applies to TLD registries and DNS providers only (Article 28) | Данни за регистрация на домейни — само за регистри на имена на домейни от първо ниво и доставчици на DNS услуги (член 28) |

Vocabulary: essential and important entities = съществени и важни субекти; network and information system = мрежова и информационна система; early warning = ранно предупреждение; intermediate report = междинен доклад; competent authority = компетентен орган; single point of contact = единно звено за контакт; coordinated vulnerability disclosure = координирано оповестяване на уязвимости; cyber hygiene = киберхигиена.
### nist-csf
Function names are NOUNS, as the interface shows them: Govern = Управление; Identify = Идентификация; Protect = Защита; Detect = Откриване; Respond = Реакция; Recover = Възстановяване.

- Function / Category / Subcategory = Функция / Категория / Подкатегория; Core / Profile / Tier = Ядро / Профил / Ниво; Partial = Частично; Risk Informed = Информирано от риска; Repeatable = Повторяемо; Adaptive = Адаптивно; Organizational Context = Организационен контекст; Risk Management Strategy = Стратегия за управление на риска; Business Environment = Бизнес среда; Identity Management, Authentication and Access Control = Управление на идентичността, удостоверяване и контрол на достъпа; Awareness and Training = Осведоменост и обучение; Protective Technology = Защитни технологии; Continuous Monitoring = Непрекъснато наблюдение; Incident Recovery Plan Execution = Изпълнение на плана за възстановяване след инцидент.
### nist-privacy
Function names are nouns: Identify-P = Идентификация; Govern-P = Управление; Control-P = Контрол; Communicate-P = Комуникация; Protect-P = Защита. Category names shared with NIST CSF: see nist-csf. Outcome statements keep their full stop.

- Inventory and Mapping = Опис и картографиране; Data Processing Ecosystem Risk Management = Управление на риска в екосистемата за обработване на данни; Governance Policies, Processes, and Procedures = Политики, процеси и процедури за управление; Monitoring and Review = Наблюдение и преглед; Data Processing Policies, Processes, and Procedures = Политики, процеси и процедури за обработване на данни; Data Processing Management = Управление на обработването на данни; Disassociated Processing = Разграничено обработване; Communication Policies, Processes, and Procedures = Политики, процеси и процедури за комуникация; Data Processing Awareness = Осведоменост за обработването на данни; Data Protection Policies, Processes, and Procedures = Политики, процеси и процедури за защита на данните;
- privacy values = ценности, свързани с неприкосновеността; privacy event = събитие, свързано с неприкосновеността; privacy personnel = служители по неприкосновеността; systems, products, and services = системи, продукти и услуги; individuals' preferences and requests = предпочитания и искания на физическите лица; observability and linkability = наблюдаемост и свързваемост; inference (about individuals) = извод („правене на изводи“); attribute reference / attribute value = препратка към атрибут / стойност на атрибут; processing permissions = разрешения за обработване; data provenance and lineage = произход и родословие на данните; alteration = изменяне („достъп за изменяне / изтриване / преглед“); transmission or disclosure = пренос или разкриване; interoperability framework = рамка за оперативна съвместимост;
- multi-party approach = многостранен подход; data-at-rest / data-in-transit = данни в покой / данни при пренос; configuration change control = контрол на промените в конфигурацията; removal, transfers, and disposition = премахване, прехвърляне и извеждане от употреба; integrity checking mechanism = механизъм за проверка на целостта; firmware = фърмуер; communications and control networks = комуникационни и контролни мрежи; failsafe, load balancing, hot swap = отказоустойчивост, разпределение на натоварването, „гореща“ смяна; deprovisioning = отнемане на достъпа; least functionality = най-малка функционалност; owners or operators = собственици или оператори.
### nist-ssdf
Group, practice and task headings are imperatives and stay imperatives. A section heading keeps its code in front: „PO.1 Определете …“. Groups: Prepare the Organization (PO) = Подгответе организацията; Protect the Software (PS) = Защитете софтуера; Produce Well-Secured Software (PW) = Създавайте добре защитен софтуер; Respond to Vulnerabilities (RV) = Реагирайте на уязвимости.

| Practice | Bulgarian | Practice | Bulgarian |
|---|---|---|---|
| PO.1 Define Security Requirements for Software Development | Определете изискванията за сигурност при разработването на софтуер | PO.2 Implement Roles and Responsibilities | Въведете роли и отговорности |
| PO.3 Implement Supporting Toolchains | Внедрете поддържащи вериги от инструменти | PO.4 Define and Use Criteria for Software Security Checks | Определете и използвайте критерии за проверките на сигурността на софтуера |
| PO.5 Implement and Maintain Secure Environments for Software Development | Внедрете и поддържайте сигурни среди за разработване на софтуер | PS.1 Protect All Forms of Code from Unauthorized Access and Tampering | Защитете всички форми на код от неразрешен достъп и манипулиране |
| PS.2 Provide a Mechanism for Verifying Software Release Integrity | Осигурете механизъм за проверка на целостта на изданията на софтуера | PS.3 Archive and Protect Each Software Release | Архивирайте и защитете всяко издание на софтуера |
| PW.1 Design Software to Meet Security Requirements and Mitigate Security Risks | Проектирайте софтуера така, че да отговаря на изискванията за сигурност и да смекчава рисковете за сигурността | PW.2 Review the Software Design to Verify Compliance with Security Requirements and Risk Information | Прегледайте проекта на софтуера, за да проверите съответствието с изискванията за сигурност и с информацията за рисковете |
| PW.4 Reuse Existing, Well-Secured Software When Feasible Instead of Duplicating Functionality | Използвайте повторно съществуващ, добре защитен софтуер, когато е възможно, вместо да дублирате функционалност | PW.5 Create Source Code by Adhering to Secure Coding Practices | Създавайте изходния код, като спазвате практиките за сигурно програмиране |
| PW.6 Configure the Compilation, Interpreter, and Build Processes to Improve Executable Security | Конфигурирайте процесите на компилиране, интерпретиране и изграждане така, че да подобряват сигурността на изпълнимия код | PW.7 Review and/or Analyze Human-Readable Code to Identify Vulnerabilities and Verify Compliance with Security Requirements | Преглеждайте и/или анализирайте кода, четим от човек, за да идентифицирате уязвимости и да проверите съответствието с изискванията за сигурност |
| PW.8 Test Executable Code to Identify Vulnerabilities and Verify Compliance with Security Requirements | Тествайте изпълнимия код, за да идентифицирате уязвимости и да проверите съответствието с изискванията за сигурност | PW.9 Configure Software to Have Secure Settings by Default | Конфигурирайте софтуера така, че настройките му по подразбиране да са сигурни |
| RV.1 Identify and Confirm Vulnerabilities on an Ongoing Basis | Идентифицирайте и потвърждавайте уязвимостите текущо | RV.2 Assess, Prioritize, and Remediate Vulnerabilities | Оценявайте, приоритизирайте и отстранявайте уязвимостите |
| RV.3 Analyze Vulnerabilities to Identify Their Root Causes | Анализирайте уязвимостите, за да идентифицирате първопричините им |  |  |

- Fully / Largely / Partially / Not Implemented = Напълно внедрено / В голяма степен внедрено / Частично внедрено / Не е внедрено; software release = издание на софтуера; software security checks = проверки на сигурността на софтуера; release gate = контролна точка преди пускане; integrity verification information = информация за проверка на целостта; cryptographic hash = криптографска хеш стойност; compiler, interpreter, build tools = компилатор, интерпретатор, инструменти за изграждане; configuration-as-code = конфигурация като код; peer code review = преглед на кода от колега; human-readable code = код, четим от човек; secure-by-default configuration = сигурна конфигурация по подразбиране; secure baseline = сигурна базова конфигурация;
- attack modeling, attack surface mapping = моделиране на атаките, картографиране на повърхността на атака; software acquirer = придобиващ софтуера; authorizing official = оправомощено длъжностно лице; risk-based approach = подход, основан на риска; issue tracking system = система за проследяване на проблеми; secrets committed to source control = тайни, записани в системата за контрол на версиите; unreviewed code merged to production = непрегледан код, слят в производствената среда.
### owasp-agentic
A section heading keeps its code: „ASI01 Подмяна на целта на агента“.

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| ASI01 Agent Goal Hijack | Подмяна на целта на агента | ASI02 Tool Misuse and Exploitation | Злоупотреба с инструменти и експлоатирането им | ASI03 Identity and Privilege Abuse | Злоупотреба с идентичност и привилегии |
| ASI04 Agentic Supply Chain Vulnerabilities | Уязвимости във веригата за доставки на агентни системи | ASI05 Unexpected Code Execution | Неочаквано изпълнение на код | ASI06 Memory and Context Poisoning | Отравяне на паметта и контекста |
| ASI07 Insecure Inter-Agent Communication | Несигурна комуникация между агенти | ASI08 Cascading Failures | Каскадни откази | ASI09 Human-Agent Trust Exploitation | Експлоатиране на доверието между човек и агент |
| ASI10 Rogue Agents | Агенти извън контрол | Bounding the risk upfront | Предварително ограничаване на риска | Human accountability and control | Човешка отчетност и контрол |
| Technical guardrails | Технически предпазни механизми | Traceability, evaluation and response | Проследимост, оценка и реакция |  |  |
### owasp-aisvs
"(AISVS C5)" is copied; a section heading keeps its code: „C2.1 Защити срещу инжектиране на подкана“. Levels: L1 = Основно; L2 = Стандартно; L3 = Разширено.

| # | Bulgarian | # | Bulgarian | # | Bulgarian |
|---|---|---|---|---|---|
| C1 Training Data Integrity & Traceability | Цялост и проследимост на обучителните данни | C2 Input Validation | Валидиране на входящите данни | C3 Model Lifecycle Management & Change Control | Управление на жизнения цикъл на модела и контрол на промените |
| C4 Infrastructure, Configuration & Deployment Security | Сигурност на инфраструктурата, конфигурацията и внедряването | C5 Access Control & Identity for AI Components & Users | Контрол на достъпа и идентичност за компоненти и потребители на ИИ | C6 Supply Chain Security for Models | Сигурност на веригата за доставки на модели |
| C7 Model Behavior, Output Control & Safety Assurance | Поведение на модела, контрол на резултатите и осигуряване на безопасността | C8 Memory, Embeddings & Vector Database Security | Сигурност на паметта, векторните представяния и векторните бази данни | C9 Orchestration & Agentic Security | Оркестрация и сигурност на агентните системи |
| C10 Model Context Protocol (MCP) Security | Сигурност на Model Context Protocol (MCP) | C11 Adversarial Robustness | Устойчивост на враждебни атаки | C12 Monitoring, Logging & Anomaly Detection | Наблюдение, водене на дневници и откриване на аномалии |

- access token (issuer, audience, expiry, scope) = токен за достъп (издател, получател, срок на валидност, обхват); AI-augmented review = преглед, подпомаган от ИИ; checkpoint = контролна точка; clean-label poisoning = отравяне с чисти етикети; confidence scoring / threshold = оценка на увереността / праг на увереност; confidential inference = поверителен извод; controlled deployment and rollback = контролирано внедряване и връщане към предишна версия; covert channel = скрит канал; data labeling and annotation = етикетиране и анотиране на данни; default-deny allow-list = разрешителен списък с отказ по подразбиране; differential privacy = диференциална поверителност; execution budget / execution environment = бюджет за изпълнение / среда за изпълнение; generated media = генерирано медийно съдържание;
- hardware-backed keys = хардуерно защитени ключове; high-impact action = действие със силно въздействие; indirect prompt injection = непряко инжектиране на подкана; instruction hierarchy = йерархия на инструкциите; just-in-time access = достъп при необходимост; loop control = контрол на циклите; machine-readable = машинночетим; membership inference = извод за принадлежност; memory expiry and revocation = изтичане и отнемане на паметта; model artifact / model authorization = артефакт на модела / оторизация на модела; model inversion / model extraction = инверсия на модела / извличане на модела; multi-modal = мултимодален; multi-tenant isolation = изолация между наематели; out-of-band channel = извънлентов канал; output format enforcement = налагане на формата на резултатите;
- policy engine = механизъм за политики; probing = сондиране; quantized model = квантуван модел; reserved tokens = запазени токени; reward hacking = манипулиране на наградата; self-modification = самомодифициране; shutdown and graceful degradation = спиране и плавно влошаване на работата; source attribution and citation integrity = посочване на източниците и цялост на цитиранията; staged rollout = поетапно внедряване; step-up authentication = допълнително удостоверяване; system message = системно съобщение; tool authorization / tool manifest = оторизация на инструментите / манифест на инструмента; transport ("Secure Transport") = транспорт („Сигурен транспорт“); irreversibility / reversibility = необратимост / обратимост.
### owasp-asvs
"(ASVS L1)" is copied. Requirement names are short noun phrases or imperatives; keep the form of the source. Header names, cookie attributes and protocol names stay as written: Content Security Policy, Content-Disposition, Content-Type, Referrer Policy, Strict Transport Security, HttpOnly, SameSite, Secure, Origin, Host, CORS, TLS, GraphQL, SOAP.

| Chapter | Bulgarian | Chapter | Bulgarian | Chapter | Bulgarian | Chapter | Bulgarian |
|---|---|---|---|---|---|---|---|
| V1 Architecture, Design and Threat Modeling | Архитектура, проектиране и моделиране на заплахите | V2 Authentication | Удостоверяване | V3 Session Management | Управление на сесиите | V4 Access Control | Контрол на достъпа |
| V5 Validation, Sanitization and Encoding | Валидиране, пречистване и кодиране | V6 Stored Cryptography | Криптография при съхранение | V7 Error Handling and Logging | Обработване на грешки и водене на дневници | V8 Data Protection | Защита на данните |
| V9 Communication | Комуникация | V10 Malicious Code | Зловреден код | V11 Business Logic | Бизнес логика | V12 Files and Resources | Файлове и ресурси |
| V13 API and Web Service | API и уеб услуги | V14 Configuration | Конфигурация |  |  |  |  |

- anti-automation = защита срещу автоматизация; backdoor = задна врата; breached password = компрометирана парола; Broken Access Control / Broken Authentication = нарушен контрол на достъпа / нарушено удостоверяване; buffer bounds checking = проверка на границите на буфера; business rule limits = ограничения на бизнес правилата; cipher mode = режим на шифъра; client-side storage / server-side = съхранение от страна на клиента / от страна на сървъра; compiler flags = флагове на компилатора; constant-time comparison = сравнение за постоянно време; context-aware output encoding = контекстно кодиране на изхода; Cross-Site Scripting = междусайтов скриптинг; cryptographic randomness = криптографска случайност; deserialization = десериализация; directory browsing = преглеждане на директории;
- executable extension = разширение на изпълним файл; fail securely = сигурен отказ („Сигурен отказ при грешки в достъпа“); HTTP parameter pollution = замърсяване на HTTP параметри; impersonation resistance / replay resistance = устойчивост на представяне за друг / на повторно изпълнение; inactivity and absolute timeout = време за изчакване при неактивност и абсолютно време за изчакване; logout = изход; lookup secret = код за възстановяване; mass assignment = масово присвояване; memory-safe = безопасен за паметта; object reference = препратка към обект; one-time password = еднократна парола; OS command injection = инжектиране на команди на операционната система; out-of-band = извънлентов; oversized upload = качен файл с прекомерен размер; parameterized queries = параметризирани заявки;
- password hint / password strength = подсказка за парола / сложност на паролата; path manipulation = манипулиране на пътя; payload = полезни данни; phone-home = скрито свързване с външен сървър; race condition = състояние на състезание; redirect = пренасочване; repeatable build = повторяемо изграждане; salt / salted hashing = сол / хеширане със сол; Security Misconfiguration = неправилна конфигурация на сигурността; structured exception handling = структурирано обработване на изключения; subdomain takeover = превземане на поддомейн; tamper-resistant logs = дневници, устойчиви на манипулиране; template injection = инжектиране в шаблони; trusted enforcement point = доверена точка на налагане; Up-to-Date Dependencies = актуални зависимости; vault = трезор; verification requirement = изискване за проверка;
- Vulnerable and Outdated Components = уязвими и остарели компоненти; web root = главна уеб директория; work factor = работен фактор.

Stay in Latin as attack or parameter names: padding oracle, nonce, IV, XSS, CSRF, SSRF, clickjacking, many-shot jailbreak.
### policy-templates
"X Policy" = „Политика за X“, "X Plan" = „План за X“, "X Procedure" = „Процедура за X“, with X as in the `shared` table („Политика за управление на достъпа“, „Политика за сигурно разработване“, „План за непрекъснатост на дейността“). The titles that are not obvious:

| English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|
| Backup Policy | Политика за резервните копия | Business Continuity & DR Policy | Политика за непрекъснатост на дейността и възстановяване след бедствие | Business Impact Analysis Procedure | Процедура за анализ на въздействието върху дейността |
| Cloud Services Policy | Политика за услугите в облак | Communication Procedure and Plan | Процедура и план за комуникация | Corporate Governance of Information Security Policy | Политика за корпоративно управление на информационната сигурност |
| Data Classification & Handling Policy | Политика за класификация и боравене с данни | Documents and Records Policy | Политика за документите и записите | IT Security Policy | Политика за ИТ сигурност |
| Incident Response & Communications Policy | Политика за реакция при инциденти и комуникации | Information Security Management Policy (NIS2) | Политика за управление на информационната сигурност (NIS2) | Mobile Device Management & BYOD Policy | Политика за управление на мобилни устройства и BYOD |
| Physical & Environmental Security Policy | Политика за физическа сигурност и сигурност на околната среда | Privacy Policy | Политика за поверителност | Third-Party & External Systems Policy | Политика за трети страни и външни системи |
| Threat & Vulnerability Management Policy | Политика за управление на заплахите и уязвимостите |  |  |  |  |
### shared
Headings used by several families: translate them family-neutrally, with core vocabulary. Roles and categories are in the closed-set tables; CSF tiers in nist-csf; clause names (Leadership, Planning, Support, Operation, Improvement) in iso-clauses.

| English | Bulgarian | English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|---|---|
| Access Control / Access Management | Контрол на достъпа / Управление на достъпа | Asset Management | Управление на активите | Authentication | Удостоверяване | Awareness Management | Управление на осведомеността |
| Backup | Резервни копия | Business Continuity | Непрекъснатост на дейността | Change and Configuration Management | Управление на промените и конфигурацията | Cloud Services | Услуги в облак |
| Communication / Communication Security | Комуникация / Сигурност на комуникациите | Compliance Management | Управление на съответствието | Data Leakage Prevention | Предотвратяване на изтичане на данни | Data Protection / Data Security | Защита на данните / Сигурност на данните |
| Documents and Records | Документи и записи | Hardening | Укрепване на защитата | Human Resources Security | Сигурност на човешките ресурси | ICS/OT Security / IT Security | Сигурност на ICS/OT / ИТ сигурност |
| Incident Management | Управление на инциденти | Information Security / Information Security Policy | Информационна сигурност / Политика за информационна сигурност | Logging and Monitoring | Водене на дневници и наблюдение | Physical Security | Физическа сигурност |
| Privacy | Неприкосновеност на личния живот | Risk Assessment | Оценка на риска | Risk Management / Risk Management Policy / Risk Management Strategy | Управление на риска / Политика за управление на риска / Стратегия за управление на риска | Secure Development | Сигурно разработване |
| Segregation of duties | Разделяне на задълженията | Sensitive Data Exposure | Разкриване на чувствителни данни | Supplier Management | Управление на доставчиците | Supply chain security management | Управление на сигурността на веригата за доставки |
### soc2
No Bulgarian edition exists. Trust Services Criteria in running text = критерии за доверие към услугите; common criteria = общи критерии. Series names: Security = Сигурност; Availability = Наличност; Processing Integrity = Цялост на обработването; Confidentiality = Поверителност; Privacy = Неприкосновеност на личния живот.

| English | Bulgarian | English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|---|---|
| CC1 Control Environment | Контролна среда | CC2 Communication & Information | Комуникация и информация | CC3 Risk Assessment | Оценка на риска | CC4 Monitoring Activities | Дейности по мониторинг |
| CC5 Control Activities | Контролни дейности | CC6 Logical & Physical Access Controls | Контрол на логическия и физическия достъп | CC7 System Operations | Експлоатация на системите | CC8 Change Management | Управление на промените |
| CC9 Risk Mitigation | Смекчаване на риска |  |  |  |  |  |  |

- Board Independence = Независимост на съвета; Quality Information = Качествена информация; User Registration and Credential Removal = Регистриране на потребители и премахване на идентификационни данни; Secure Asset and Media Disposal = Сигурно извеждане от употреба на активи и носители; Boundary Protection = Защита на границите на мрежата; Information Transmission and Movement = Пренос и преместване на информация; Change Authorization = Разрешаване на промени; Vendor Risk = Риск, свързан с доставчици; control matrix = матрица на контролите; annual acknowledgement = ежегодно потвърждение; patching = прилагане на корекции; exception (in a SOC report) = отклонение; service organization = обслужваща организация.
### vendor-questionnaires
Answer labels are in the closed-set table.

| English | Bulgarian | English | Bulgarian | English | Bulgarian | English | Bulgarian |
|---|---|---|---|---|---|---|---|
| Supplier Due Diligence Questionnaire | Въпросник за надлежна проверка на доставчици | Supplier Security Assessment | Оценка на сигурността на доставчик | Company Information | Информация за дружеството | Certifications | Сертификати |
| Data to be Exchanged | Данни, които ще се обменят | Security Controls | Контроли за сигурност | Third Parties | Трети страни |  |  |

## Traps
English words with a tempting wrong rendering ("wrong" = wrong here). Single-word warnings are in the notes of "Core terms"; these are the pairs and triples that get swapped.

| English | Wrong here | Right |
|---|---|---|
| control (a safeguard) | управление; проверка; контрола; механизъм за контрол | контрол, pl. контроли |
| control (to govern: "Document Control", "Control of nonconforming outputs", "Operational planning and control") | контрол | управление |
| controls of one function ("Access Controls", "Weak Access Controls") | контроли на достъпа | контрол на достъпа (singular) |
| Controller / Processor (GDPR, ISO 27701) | контролер, контрольор / процесор | администратор / обработващ (лични данни, PII) |
| privacy / confidentiality | поверителност for both | неприкосновеност / поверителност |
| safety / security | swapped | безопасност / сигурност |
| integrity | интегритет; почтеност for data; цялост for ethics | цялост (data, systems) / почтеност (COSO P1, SOC 2 CC1.1) |
| accountability / responsibility | отговорност for both | отчетност / отговорност |
| governance / management (the people) / leadership | гавърнънс; ръководство; управление | управление / ръководство / лидерство |
| authorization / authorized | упълномощаване for both | оторизация (access decision) · разрешение (permission) / разрешен, оправомощен |
| authentication / identity | автентикация; идентификация | удостоверяване / идентичност (system), самоличност (person) |
| account | сметка (IT); акаунт (ledger) | акаунт (IT) / сметка (COSO ledger) |
| encryption / encoding / hashing | шифроване; кодиране for encryption | криптиране / кодиране / хеширане |
| review / audit / assessment / testing | used interchangeably | преглед / одит / оценка / тестване |
| remediation / mitigation / treatment | used interchangeably | отстраняване / смекчаване / третиране |
| incident / event | swapped | инцидент / събитие |
| disclosure | разкриване everywhere | разкриване (of data) / оповестяване (to the public, of vulnerabilities, financial) |
| transfer | трансфер | предаване (data) / прехвърляне (ownership, risk) / пренос (ISO 5.14) |
| request / response | искане (HTTP); реакция (HTTP) | заявка (HTTP) · искане (data subject) / отговор (HTTP, model) · реакция (incident, risk) |
| output / input | изход, вход | резултат (AI) · изходни данни (software) / входящи данни |
| release / build / deployment | освобождаване / билд, строеж / деплой, инсталация | издание, пускане / изграждане / внедряване |
| maintenance / Support (ISO clause 7) / Operation (ISO clause 8) | поддържане / поддръжка, подкрепа / операция, експлоатация | поддръжка / поддържане / функциониране |
| performance | изпълнение everywhere | резултатност (management system) / производителност (technical) / изпълнение (people) |
| disposal | разпореждане; изхвърляне | унищожаване (data, media) / извеждане от употреба (equipment) |
| media / facilities / utilities | медии / удобства / помощни програми | носители / съоръжения / комунални услуги (utility programs = помощни програми) |
| retrieval / recovery | both възстановяване | извличане / възстановяване |
| labelling / screening | one word for both senses | маркиране (ISO 5.13) · етикетиране (training data) / проучване (people) · проверка (content) |
| board / committee / charter | борд / комисия / харта, устав | съвет (на директорите) / комитет / статут |
| materiality / reconciliation / journal entries | материалност / помирение / журнални записи | същественост / равнение / счетоводни записвания |
| concern ("raise a concern") / officer / stakeholder | загриженост / офицер / акционер | сигнал / длъжностно лице / заинтересована страна |
| third-party testing | тестване на трети страни | тестване от трета страна |
| Model (in "IMDA Model AI Governance Framework") | модел на ИИ | part of the name, unchanged |
| Trust Services Criteria / common criteria (SOC 2) | удостоверителни услуги / Common Criteria | name stays Latin / общи критерии |
| Clause / Annex A | клауза / Анекс А, приложение А (Cyrillic А) | точка / приложение A (Latin A, part of the code "A.5.1") |
| open category / standard scenario / UAS operations | отворена / стандартен сценарий / операции | неограничена / основен сценарий / експлоатация |
| EU AI Act | Закон за ИИ; AI Act | Акт за изкуствения интелект на ЕС |

**One English word, a different official word in each EU act.** Use the word of the act the heading belongs to; outside the EU families use the core term.

| English | GDPR | NIS2 | DORA | AI Act | UAS |
|---|---|---|---|---|---|
| the "big" incident | нарушение на сигурността на лични данни | значителен инцидент | съществен инцидент с ИКТ | сериозен инцидент | случай, свързан с безопасността |
| management body | | управителен орган | ръководен орган | | |
| intermediate report | | междинен доклад | неокончателен доклад | | |
| vulnerability | | уязвимост | уязвимо място | | |
| business continuity | | непрекъснатост на стопанската дейност | непрекъснатост на дейността | | |
| incident handling / response | | действия при инцидент | реакция и възстановяване | | план за реагиране при извънредни ситуации |
| ICT + noun | | ИКТ продукт, ИКТ услуга | риск в областта на ИКТ, услуги в областта на ИКТ | | |
| supply chain | | верига за доставка | | верига на доставки | |
| testing | | | тестване | изпитване | |
| robustness | | | | надеждност | стабилност |
| authority | надзорен орган | компетентен орган; CSIRT | компетентен орган | орган за надзор на пазара | компетентен орган |

## Open questions
Decisions already applied above that the project lead may want to overrule, and terms that keep real doubt. Translators: use the glossary as written and never copy "(?)" into a heading.

1. **AI system.** Glossary: „система с ИИ“ everywhere (AI Act, БДС; 6 interface strings, among them the entity name). The interface page title and lists say „ИИ системи“ (15 strings), „AI системи“ (3). One side should be aligned.
2. **Clause.** Glossary: „Точка“ (style rule 4, БДС). The interface says „Клаузи (4–10)“.
3. **Inventory.** Glossary: „опис“ (style rule 3). The interface page is „Инвентар на активите“.
4. **Privacy.** Glossary: „неприкосновеност“ (confidentiality keeps „поверителност“). The interface writes „поверителност“ for both.
5. **Unauthorized.** Glossary: „неразрешен“ (GDPR, AI Act; no EU act says „неоторизиран“). The interface says „Неоторизиран достъп“ (5 strings: an incident type, a starter risk).
6. **Supply chain.** Glossary: „верига за доставки“ (БДС ISO/IEC 27036, starter content); NIS2 Art. 21(2)(d) keeps its own „верига за доставка“. The interface and the recitals of NIS2 mostly say „верига на доставки“.
7. **Names of the acts.** „Директива NIS2“ (official short title: „Директива МИС 2“). „Акт за изкуствения интелект на ЕС“ (the interface has four spellings). "Digital Operational Resilience Act" = „Акт за оперативната устойчивост на цифровите технологии“: the Official Journal gives DORA no short title; the cautious alternative is „Регламент за …“.
8. **Interface strings that differ from the official wording used here:** „CSIRT“ (official: „CSIRT“), „Регистър на информацията (DORA)“ (official: „информационен регистър“), „чл.“ for "Art." (style rule 4 keeps "Art." as in the source), „Многофакторно удостоверяване“ (NIS2 Art. 21(2)(j): „… на автентичността“).
9. **UAS.** „БЛС“ for UAS and the label pattern „БЛС в ЕС: …“ for the eleven "EU UAS …" categories; „неограничена“ for "open" (pilots may know it as „отворена“); „удостоверение“ (Part C title) rather than „свидетелство“ (Art. 2(9)) for the LUC.
10. **Category pattern and capitals.** A colon was added after the framework name („AIUC-1: сигурност“, „FINOS AIGF: достъп“); the source has no separator. After " - " or " — " the title keeps its capital („Член 21 - Мерки …“); read strictly, style rule 2 would lower-case it.
11. **Risk and control categories** are masculine singular („Оперативен“, „Репутационен“, „Правен“); the interface has both „Оперативен“ and „Оперативни“.
12. **Management-system acronyms.** СУСИ (ISMS) and СУК (QMS) are established; PIMS (PIMS), AIMS (AIMS) and BCMS (BCMS) are not. Fallback: keep the Latin acronym.
13. **ISO titles are reconstructed**: the БДС text is not public. Least certain: clause 8 „Функциониране“ (БДС EN ISO 9001:2015 has „Дейности“), clause 7.3 „Осъзнаване“, 5.3 „пълномощия“, 6.2 (ISO 39001), 8.6, 10.1; controls 5.13, 5.14, 5.17, 5.31, 6.2, 6.3, 7.2, 7.6, 7.11, 7.14, 8.15, 8.33. ISO 27701 „субект на PII“.
14. **Terms with no established Bulgarian equivalent** (decided, low confidence): production = „производствена среда“ (the interface says „продукционна среда“, БДС titles „експлоатация“); hardening = „укрепване на защитата“; pipeline = „конвейер“; sanitization = „пречистване“; triage = „първична оценка“; embedding = „векторно представяне“; guardrail = „предпазен механизъм“; fine-tuning = „фино настройване“; drift = „дрейф“; alignment = „съгласуваност“; data lineage = „родословие на данните“; plugin = „приставка“; red teaming = „атакуващо тестване“; tenant = „наемател“; out-of-band = „извънлентов“; payload (ASVS) = „полезни данни“; phone-home; ransomware = „софтуер за откуп“; Cross-Site Scripting = „междусайтов скриптинг“; "Disassociated Processing" = „Разграничено обработване“; "Rogue Agents" = „Агенти извън контрол“; "Agent Goal Hijack" = „Подмяна на целта на агента“; "redress channels"; "meaningful" (IMDA D2) = „реална“; ICFR kept Latin; jailbreak kept Latin.
15. **Roles** not named by any act: „Административно-стопански отдел“ (Facilities), „Ръководител на летателната експлоатация“, „Ръководител на флота и техническото обслужване“, „Оперативен ръководител“, „Ръководител по безопасността“.
16. **Other interface wording not followed.** Logging: „водене на дневници“ / „дневник“ here; the interface has „логване и мониторинг“ once, „журнал“ 9 times, and the starter content „журналиране и наблюдение“. Audit log: „одитен дневник“ here (3 interface strings); the interface page is „Одитна пътека“. BIA: „… върху дейността“ here (DORA, 2 interface strings); the report template and the entity name say „… върху бизнеса“. Development: „разработване“ here; the interface has „Разработка“ once. Physical and environmental security: „… на околната среда“ here (БДС); the interface label says „… на средата“. Data breach: „нарушение на сигурността на данните“ here (GDPR); the interface incident type is „Пробив в данните“. Input: „входящи данни“ here (AI Act); the interface has „входни данни“.
17. **AI Act risk tiers.** „ограничен риск“ and „минимален риск“ are not terms of the Regulation (the usual renderings).
18. **Source defects** (not translation questions): the category "Communication Procedure and" is cut off in `policy-templates-imported.json`; the label "Programatically" is misspelt; the NIS2 catalogue ids Art.23(1)–(3) are Art. 23(4)(a), (b), (d) of the Directive.
