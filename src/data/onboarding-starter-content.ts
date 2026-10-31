/**
 * The setup wizard's starter content in each language the UI ships (#4701).
 *
 * The wizard creates starter risks and tasks as ordinary rows, so their
 * text is stored, not translated on display. It used to be English
 * whatever the user's language. The English is the catalogue in
 * `onboarding-automation.ts` (`STARTER_RISKS`, `STARTER_TASKS`); this module
 * holds every other language's text, keyed by the English title, which is
 * stable and unique within each list.
 *
 * A risk category that is one of the canonical `RISK_CATEGORIES` is NOT
 * translated here: it is a filter value that the risk pages label in the
 * user's language on display, so it stays stored in English. The starter
 * categories outside that list are free text, like the title, and are
 * written in the user's language.
 *
 * `tests/unit/onboarding-starter-content.test.ts` holds every starter risk
 * and task to an entry in every language.
 */
import type { Locale } from '@/lib/locale-constants';

export interface StarterRiskText {
    title: string;
    /** Absent for a canonical category, which stays as stored. */
    category?: string;
    threat: string;
    vulnerability: string;
}

export interface StarterTaskText {
    title: string;
    description: string;
}

type Translated<T> = Readonly<Record<Exclude<Locale, 'en'>, Readonly<Record<string, T>>>>;

export const STARTER_RISK_TEXT: Translated<StarterRiskText> = {
    bg: {
        'Unauthorized Access to Application': {
            title: 'Неоторизиран достъп до приложението',
            category: 'Контрол на достъпа',
            threat: 'Достъп от неоторизиран потребител',
            vulnerability: 'Слабо удостоверяване или упълномощаване',
        },
        'Application Vulnerability Exploitation': {
            title: 'Използване на уязвимост в приложението',
            category: 'Управление на уязвимостите',
            threat: 'Използване на софтуерни уязвимости',
            vulnerability: 'Незакърпени зависимости на приложението',
        },
        'Insufficient Application Logging': {
            title: 'Недостатъчно журналиране в приложението',
            category: 'Журналиране и наблюдение',
            threat: 'Неоткрити инциденти със сигурността',
            vulnerability: 'Недостатъчно събиране и наблюдение на журнали',
        },
        'Application Availability Disruption': {
            title: 'Прекъсване на достъпността на приложението',
            category: 'Достъпност',
            threat: 'Прекъсване на услугата или влошена производителност',
            vulnerability: 'Единична точка на отказ в архитектурата',
        },
        'Data Backup Failure': {
            title: 'Неуспешно резервно копиране на данни',
            category: 'Непрекъснатост на дейността',
            threat: 'Загуба на данни поради неуспешно резервно копиране',
            vulnerability: 'Непроверени или неправилно настроени процедури за резервно копиране',
        },
        'Data Confidentiality Breach': {
            title: 'Нарушаване на поверителността на данните',
            category: 'Поверителност',
            threat: 'Неоторизиран достъп до данни или изнасянето им',
            vulnerability: 'Недостатъчно криптиране или контрол на достъпа',
        },
        'Data Integrity Compromise': {
            title: 'Нарушаване на целостта на данните',
            category: 'Цялост на данните',
            threat: 'Неоторизирана промяна на данни',
            vulnerability: 'Липса на механизми за проверка на целостта',
        },
        'Network Perimeter Breach': {
            title: 'Пробив в мрежовия периметър',
            category: 'Мрежова сигурност',
            threat: 'Външна мрежова атака',
            vulnerability: 'Неправилно настроени защитни стени или групи за сигурност',
        },
        'Cloud Misconfiguration': {
            title: 'Неправилна облачна конфигурация',
            category: 'Облачна сигурност',
            threat: 'Излагане на облачни ресурси',
            vulnerability: 'Неправилно настроени IAM политики или публични хранилища',
        },
        'Third-Party Data Processing Risk': {
            title: 'Риск при обработка на данни от трети страни',
            category: 'Управление на доставчици',
            threat: 'Изтичане или злоупотреба с данни при доставчик',
            vulnerability: 'Недостатъчна проверка на доставчиците или недостатъчни договори',
        },
        'Supply Chain Dependency Risk': {
            title: 'Риск от зависимост от веригата за доставки',
            category: 'Верига за доставки',
            threat: 'Прекъсване поради отказ на доставчик',
            vulnerability: 'Прекомерна зависимост от един доставчик',
        },
        'Insider Threat': {
            title: 'Вътрешна заплаха',
            threat: 'Злонамерени или небрежни действия на служител',
            vulnerability: 'Недостатъчен контрол на достъпа и наблюдение',
        },
        'Incident Response Failure': {
            title: 'Неуспешно реагиране при инциденти',
            category: 'Управление на инциденти',
            threat: 'Неадекватно реагиране при инциденти',
            vulnerability: 'Липса на план и обучение за реагиране при инциденти',
        },
        'Regulatory Non-Compliance': {
            title: 'Несъответствие с регулаторните изисквания',
            threat: 'Регулаторни санкции или глоби',
            vulnerability: 'Недостатъчно наблюдение на съответствието',
        },
        'Physical Security Breach': {
            title: 'Нарушаване на физическата сигурност',
            category: 'Физическа сигурност',
            threat: 'Неоторизиран физически достъп',
            vulnerability: 'Слаб контрол на физическия достъп',
        },
    },
};

export const STARTER_TASK_TEXT: Translated<StarterTaskText> = {
    bg: {
        'Review and assign control owners': {
            title: 'Прегледайте и назначете собственици на контролите',
            description: 'Прегледайте регистъра на контролите и назначете собственик на всяка контрола. Така се осигурява отговорност.',
        },
        'Schedule evidence collection cadence': {
            title: 'Насрочете честотата на събиране на доказателства',
            description: 'Настройте периодично събиране на доказателства за ключовите контроли — на тримесечие или ежемесечно, според честотата на контролата.',
        },
        'Complete risk assessment review': {
            title: 'Завършете прегледа на оценката на риска',
            description: 'Прегледайте създадения регистър на рисковете и потвърдете оценките. Коригирайте вероятността и въздействието при нужда.',
        },
        'Define incident response procedure': {
            title: 'Определете процедура за реагиране при инциденти',
            description: 'Документирайте плана си за реагиране при инциденти, включително стъпките за откриване, ограничаване, премахване и възстановяване.',
        },
        'Set up vendor due diligence process': {
            title: 'Въведете процес за проверка на доставчиците',
            description: 'Установете процеса за оценка и наблюдение на съответствието на доставчиците трети страни.',
        },
    },
};
