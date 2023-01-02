// noinspection ES6MissingAwait

importScripts('libs/idb.umd.js')
importScripts('projects.js')
importScripts('main.js')

// TODO отложенный importScripts пока не работают, подробнее https://bugs.chromium.org/p/chromium/issues/detail?id=1198822
importScripts('libs/linkedom.js')
importScripts('libs/evalCore.umd.js')
importScripts('scripts/mcserverlist_silentvote.js', 'scripts/minecraftiplist_silentvote.js', 'scripts/misterlauncher_silentvote.js', 'scripts/monitoringminecraft_silentvote.js', 'scripts/serverpact_silentvote.js')

//Текущие fetch запросы
// noinspection ES6ConvertVarToLetConst
// var fetchProjects = new Map()
//ID группы вкладок в которой сейчас открыты вкладки расширения
let groupId
//Если этот браузер не поддерживает группировку вкладок
let notSupportedGroupTabs = false

let secondVoteMinecraftIpList = false

//Нужно ли сейчас делать проверку голосования, false может быть только лишь тогда когда предыдущая проверка ещё не завершилась
let check = true

//Закрывать ли вкладку после окончания голосования? Это нужно для диагностирования ошибки
let closeTabs = true

let updateAvailable = false

// noinspection JSUnresolvedVariable,JSUnresolvedFunction,ES6ConvertVarToLetConst
var evil = evalCore.getEvalInstance(self)

//Инициализация настроек расширения
// noinspection JSIgnoredPromiseFromCall
initializeConfig(true)

//Проверка: нужно ли голосовать, сверяет время текущее с временем из конфига
async function checkVote() {

    if (!settings || !initialized) return

    //Если нет интернета, то не голосуем
    if (!settings.disabledCheckInternet && !navigator.onLine) {
        return
    }

    if (check) {
        check = false
    } else {
        return
    }

    const transaction = db.transaction('projects')
    let cursor = await transaction.objectStore('projects').openCursor()
    while (cursor) {
        const project = cursor.value
        if (!project.time || project.time < Date.now()) {
            await checkOpen(project, transaction)
        }
        // noinspection JSVoidFunctionReturnValueUsed
        cursor = await cursor.continue()
    }

    check = true
}

//Триггер на голосование когда подходит время голосования
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (settings?.debug) console.log('chrome.alarms.onAlarm', JSON.stringify(alarm))
    // noinspection JSIgnoredPromiseFromCall
    checkVote()
})

async function reloadAllAlarms() {
    await new Promise(resolve => chrome.alarms.clearAll(resolve))
    let cursor = await db.transaction('projects').store.openCursor()
    const times = []
    while (cursor) {
        const project = cursor.value
        if (project.time != null && project.time > Date.now() && times.indexOf(project.time) === -1) {
            chrome.alarms.create(String(cursor.key), {when: project.time})
            times.push(project.time)
        }
        // noinspection JSVoidFunctionReturnValueUsed
        cursor = await cursor.continue()
    }
}

self.addEventListener('online', ()=> {
    // noinspection JSIgnoredPromiseFromCall
    checkVote()
})

let promises = []
async function checkOpen(project, transaction) {
    //Если нет подключения к интернету
    if (!settings.disabledCheckInternet && !navigator.onLine) {
        return
    }

    for (const[tab,projectKey] of openedProjects.entries()) {
        // noinspection JSCheckFunctionSignatures
        const value = await transaction.objectStore('projects').get(projectKey)
        if (value.timeoutQueue && Date.now() > value.timeoutQueue) {
            if (value.timeoutQueue) {
                delete value.timeoutQueue
                updateValue('projects', value)
            }
            if (!value.nextAttempt || Date.now() > value.nextAttempt) {
                openedProjects.delete(tab)
                db.put('other', openedProjects, 'openedProjects')
                continue
            }
        }
        if (project.rating === value.rating || (value.randomize && project.randomize) || settings.disabledOneVote) {
            if (Date.now() < value.nextAttempt) {
                return
            } else if (project.key === projectKey) {
                console.warn(getProjectPrefix(project, true) + chrome.i18n.getMessage('timeout'))
                if (!settings.disabledNotifWarn) sendNotification(getProjectPrefix(project, false), chrome.i18n.getMessage('timeout'))
                openedProjects.delete(tab)
                db.put('other', openedProjects, 'openedProjects')
                // noinspection JSCheckFunctionSignatures
                if (closeTabs && !isNaN(tab)) {
                    tryCloseTab(tab, project, 0)
                }
                break
            }
        }
    }


    let retryCoolDown
    if (project.randomize) {
        retryCoolDown = Math.floor(Math.random() * 600000 + 1800000)
    } else if (/*project.rating === 'TopCraft' || project.rating === 'McTOP' || project.rating === 'MCRate' || (project.rating === 'MinecraftRating' && project.game === 'projects') ||*/ project.rating === 'MonitoringMinecraft' || project.rating === 'ServerPact' || project.rating === 'MinecraftIpList' || project.rating === 'MCServerList' || (project.rating === 'MisterLauncher' && project.game === 'projects')) {
        retryCoolDown = 300000
    } else {
        retryCoolDown = 900000
    }
    project.nextAttempt = Date.now() + retryCoolDown

    openedProjects.set('background_' + project.key, project.key)
    db.put('other', openedProjects, 'openedProjects')

    if (settings.debug) console.log(getProjectPrefix(project, true) + 'пред запуск')

    if (project.rating === 'MonitoringMinecraft') {
        promises.push(clearMonitoringMinecraftCookies())
        async function clearMonitoringMinecraftCookies() {
            let url
            if (project.rating === 'MonitoringMinecraft') {
                url = '.monitoringminecraft.ru'
            }
            let cookies = await chrome.cookies.getAll({domain: url})
            if (settings.debug) console.log(chrome.i18n.getMessage('deletingCookies', url))
            for (let i = 0; i < cookies.length; i++) {
                if (cookies[i].domain.charAt(0) === '.') cookies[i].domain = cookies[i].domain.substring(1, cookies[i].domain.length)
                await chrome.cookies.remove({url: 'https://' + cookies[i].domain + cookies[i].path, name: cookies[i].name})
            }
        }
    }

    newWindow(project)
}

//Открывает вкладку для голосования или начинает выполнять fetch запросы
async function newWindow(project) {
    //Ожидаем очистку куки
    let result = await Promise.all(promises)
    while (result.length < promises.length) {
        result = await Promise.all(promises)
    }

    console.log(getProjectPrefix(project, true) + chrome.i18n.getMessage('startedAutoVote'))
    if (!settings.disabledNotifStart) sendNotification(getProjectPrefix(project, false), chrome.i18n.getMessage('startedAutoVote'))

    if (new Date(project.stats.lastAttemptVote).getMonth() < new Date().getMonth() || new Date(project.stats.lastAttemptVote).getFullYear() < new Date().getFullYear()) {
        project.stats.lastMonthSuccessVotes = project.stats.monthSuccessVotes
        project.stats.monthSuccessVotes = 0
    }
    project.stats.lastAttemptVote = Date.now()

    if (new Date(generalStats.lastAttemptVote).getMonth() < new Date().getMonth() || new Date(generalStats.lastAttemptVote).getFullYear() < new Date().getFullYear()) {
        generalStats.lastMonthSuccessVotes = generalStats.monthSuccessVotes
        generalStats.monthSuccessVotes = 0
    }
    generalStats.lastAttemptVote = Date.now()

    if (new Date(todayStats.lastAttemptVote).getDay() < new Date().getDay()) {
        todayStats = {
            successVotes: 0,
            errorVotes: 0,
            laterVotes: 0,
            lastSuccessVote: null,
            lastAttemptVote: null
        }
    }
    todayStats.lastAttemptVote = Date.now()
    await db.put('other', generalStats, 'generalStats')
    await db.put('other', todayStats, 'todayStats')
    await updateValue('projects', project)

    let create = true
    let alarms = await chrome.alarms.getAll()
    for (const alarm of alarms) {
        if (alarm.scheduledTime === project.nextAttempt) {
            create = false
            break
        }
    }
    if (create) {
        chrome.alarms.create(String(project.key), {when: project.nextAttempt})
    }

    if (!settings.disabledUseRemoteCode) {
        try {
            const response = await fetch('https://serega007ru.github.io/Auto-Vote-Rating/projects.js')
            const projects = await response.text()
            evil(projects)
        } catch (error) {
            console.error(getProjectPrefix(project, true) + 'Ошибка при получении удалённого кода, использую вместо этого локальный код', error)
        }
    }

    let silentVoteMode = false
    if (project.rating === 'Custom') {
        silentVoteMode = true
    } else if (settings.enabledSilentVote) {
        if (!project.emulateMode && allProjects[project.rating]('silentVote', project)) {
            silentVoteMode = true
        }
    } else if (project.silentMode && allProjects[project.rating]('silentVote', project)) {
        silentVoteMode = true
    }
    if (silentVoteMode) {
        openedProjects.set('background_' + project.key, project.key)
        db.put('other', openedProjects, 'openedProjects')
        silentVote(project)
    } else {
        const windows = await chrome.windows.getAll()
            .catch(error => console.error(chrome.i18n.getMessage('errorOpenTab') + error))
        if (windows == null || windows.length <= 0) {
            const window = await chrome.windows.create({focused: false})
            await chrome.windows.update(window.id, {focused: false})
        }

        const url = allProjects[project.rating]('voteURL', project)

        let tab = await chrome.tabs.create({url, active: settings.disabledFocusedTab})
            .catch(error => endVote({message: error}, null, project))
        if (tab == null) return
        openedProjects.delete('background_' + project.key)
        openedProjects.set(tab.id, project.key)
        db.put('other', openedProjects, 'openedProjects')

        if (notSupportedGroupTabs) return
        if (!groupId) {
            let groups
            try {
                groups = await chrome.tabGroups.query({title: 'Auto Vote Rating'})
            } catch (error) {
                notSupportedGroupTabs = true
                console.warn(chrome.i18n.getMessage('notSupportedGroupTabs', error.message))
                return
            }
            if (groups.length > 0) {
                groupId = groups[0]
                await chrome.tabs.group({groupId, tabIds: tab.id})
            } else {
                try {
                    groupId = await chrome.tabs.group({createProperties: {windowId: tab.windowId}, tabIds: tab.id})
                    await chrome.tabGroups.update(groupId, {color: 'blue', title: 'Auto Vote Rating'})
                } catch (error) {
                    notSupportedGroupTabs = true
                    console.warn(chrome.i18n.getMessage('notSupportedGroupTabs', error.message))
                }
            }
        } else {
             try {
                 await chrome.tabs.group({groupId, tabIds: tab.id})
             } catch (error) {
                 if (error.message.includes('No group with id')) {
                     groupId = await chrome.tabs.group({createProperties: {windowId: tab.windowId}, tabIds: tab.id})
                     await chrome.tabGroups.update(groupId, {color: 'blue', title: 'Auto Vote Rating'})
                 } else {
                     console.warn(error.message)
                 }
             }
        }
    }
}

async function silentVote(project) {
    try {
        if (project.rating === 'Custom') {
            let response = await fetch(project.responseURL, {...project.body})
            await response.text()
            if (response.ok) {
                endVote({successfully: true}, null, project)
            } else {
                endVote({errorVote: [String(response.status), response.url]}, null, project)
            }
            return
        }

        await self['silentVote' + project.rating](project)
    } catch (e) {
        if (e.message === 'Failed to fetch' || e.message === 'NetworkError when attempting to fetch resource.') {
            // let found = false
            // for (const p of fetchProjects.values()) {
            //     if (p.key === project.key) {
            //         found = true
            //         break
            //     }
            // }
            // if (!found) {
                // endVote({notConnectInternet: true}, null, project)
                endVote({message: chrome.i18n.getMessage('errorVoteUnknown') + (e.stack ? e.stack : e)}, null, project)
            // }
        } else {
            endVote({message: chrome.i18n.getMessage('errorVoteUnknown') + (e.stack ? e.stack : e)}, null, project)
        }
    }
}

async function checkResponseError(project, response, url, bypassCodes, vk) {
    let host = extractHostname(response.url)
    if (vk && host.includes('vk.com')) {
        if (response.headers.get('Content-Type') && response.headers.get('Content-Type').includes('windows-1251')) {
            //Почему не UTF-8?
            response = await new Response(new TextDecoder('windows-1251').decode(await response.arrayBuffer()))
        }
    }
    response.html = await response.text()
    response.doc = new DOMParser().parseFromString(response.html, 'text/html')
    if (vk && host.includes('vk.com')) {
        //Узнаём причину почему мы зависли на авторизации ВК
        let text
        if (response.doc.querySelector('div.oauth_form_access') != null) {
            text = response.doc.querySelector('div.oauth_form_access').textContent.replace(response.doc.querySelector('div.oauth_access_items').textContent, '').trim()
        } else if (response.doc.querySelector('div.oauth_content > div') != null) {
            text = response.doc.querySelector('div.oauth_content > div').textContent
        } else if (response.doc.querySelector('#login_blocked_wrap') != null) {
            text = response.doc.querySelector('#login_blocked_wrap div.header').textContent + ' ' + response.doc.querySelector('#login_blocked_wrap div.content').textContent.trim()
        } else if (response.doc.querySelector('div.login_blocked_panel') != null) {
            text = response.doc.querySelector('div.login_blocked_panel').textContent.trim()
        } else if (response.doc.querySelector('.profile_deleted_text') != null) {
            text = response.doc.querySelector('.profile_deleted_text').textContent.trim()
        } else if (response.html.length < 500) {
            text = response.html
        } else {
            text = 'null'
        }
        endVote({errorAuthVK: text}, null, project)
        return false
    }
    if (!host.includes(url)) {
        endVote({message: chrome.i18n.getMessage('errorRedirected', response.url)}, null, project)
        return false
    }
    if (bypassCodes) {
        for (const code of bypassCodes) {
            if (response.status === code) {
                return true
            }
        }
    }
    if (!response.ok) {
        endVote({errorVote: [String(response.status), response.url]}, null, project)
        return false
    }
    if (response.statusText && response.statusText !== '' && response.statusText !== 'ok' && response.statusText !== 'OK') {
        endVote(response.statusText, null, project)
        return false
    }
    return true
}

chrome.webNavigation.onErrorOccurred.addListener(async function (details) {
    await waitInitialize()
    if (openedProjects.has(details.tabId)) {
        if (details.frameId === 0 || details.url.match(/hcaptcha.com\/captcha\/*/) || details.url.match(/https:\/\/www.google.com\/recaptcha\/*/) || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/*/)) {
            const project = await db.get('projects', openedProjects.get(details.tabId))
            if (
                //Chrome
                details.error.includes('net::ERR_ABORTED') || details.error.includes('net::ERR_CONNECTION_RESET') || details.error.includes('net::ERR_NETWORK_CHANGED') || details.error.includes('net::ERR_CACHE_MISS') || details.error.includes('net::ERR_BLOCKED_BY_CLIENT')
                //FireFox
                || details.error.includes('NS_BINDING_ABORTED') || details.error.includes('NS_ERROR_NET_ON_RESOLVED') || details.error.includes('NS_ERROR_NET_ON_RESOLVING') || details.error.includes('NS_ERROR_NET_ON_WAITING_FOR') || details.error.includes('NS_ERROR_NET_ON_CONNECTING_TO') || details.error.includes('NS_ERROR_FAILURE') || details.error.includes('NS_ERROR_DOCSHELL_DYING') || details.error.includes('NS_ERROR_NET_ON_TRANSACTION_CLOSE')) {
                // console.warn(getProjectPrefix(project, true) + details.error)
                return
            }
            const sender = {tab: {id: details.tabId}}
            endVote({errorVoteNetwork: [details.error, details.url]}, sender, project)
        }
    }
})

chrome.webNavigation.onDOMContentLoaded.addListener(async function(details) {
    if (details.url === 'about:blank') return
    await waitInitialize()
    const projectKey = openedProjects.get(details.tabId)
    if (!projectKey) return
    const files = []
    if (details.frameId === 0) {
        // Через эти сайты пользователь может авторизоваться, я пока не поддерживаю автоматическую авторизацию, не мешаем ему в авторизации
        if (details.url.match(/facebook.com\/*/) || details.url.match(/google.com\/*/) || details.url.match(/accounts.google.com\/*/) || details.url.match(/reddit.com\/*/) || details.url.match(/twitter.com\/*/)) {
            return
        }
        // Если пользователь авторизовывается через эти сайты, но у расширения на это нет прав, всё равно не мешаем ему, пускай сам авторизуется не смотря, на то что есть автоматизация авторизации
        if (details.url.match(/vk.com\/*/) || details.url.match(/discord.com\/*/) || details.url.startsWith('https://steamcommunity.com/openid/login')) {
            // noinspection JSUnresolvedFunction
            let granted = await chrome.permissions.contains({origins: [details.url]})
            if (!granted) {
                return
            }
        }

        files.push('scripts/main/visible.js')
        if (projectByURL(details.url)?.('needIsTrusted')) {
            files.push('scripts/main/istrusted.js')
        }
    } else if (details.url.match(/hcaptcha.com\/captcha\/*/)
            || details.url.match(/https:\/\/www.google.com\/recaptcha\/api.\/anchor*/)
            || details.url.match(/https:\/\/www.google.com\/recaptcha\/api.\/bframe*/)
            || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api.\/anchor*/)
            || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api.\/bframe*/)
            || details.url.match(/https:\/\/www.google.com\/recaptcha\/api\/fallback*/)
            || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api\/fallback*/)
            || details.url.match(/https:\/\/challenges.cloudflare.com\/*/)) {
        files.push('scripts/main/visible.js')
    }

    if (files.length === 0) return

    try {
        if (details.frameId === 0) {
            // noinspection JSCheckFunctionSignatures
            await chrome.scripting.executeScript({target: {tabId: details.tabId}, files, world: 'MAIN', injectImmediately: true})
        } else {
            // noinspection JSCheckFunctionSignatures
            await chrome.scripting.executeScript({target: {tabId: details.tabId, frameIds: [details.frameId]}, files, world: 'MAIN', injectImmediately: true})
        }
    } catch (error) {
        if (error.message !== 'The tab was closed.' && !error.message.includes('PrecompiledScript.executeInGlobal')) {
            const project = await db.get('projects', projectKey)
            console.error(getProjectPrefix(project, true) + error.message)
            if (!settings.disabledNotifError) sendNotification(getProjectPrefix(project, false), error.message)
            project.error = error.message
            updateValue('projects', project)
        }
    }
})

//Слушатель на обновление вкладок, если вкладка полностью загрузилась, загружает туда скрипт который сам нажимает кнопку проголосовать
chrome.webNavigation.onCompleted.addListener(async function(details) {
    await waitInitialize()
    const projectKey = openedProjects.get(details.tabId)
    if (!projectKey) return
    const project = await db.get('projects', projectKey)
    if (details.frameId === 0) {
        // Через эти сайты пользователь может авторизоваться, я пока не поддерживаю автоматическую авторизацию, не мешаем ему в авторизации
        if (details.url.match(/facebook.com\/*/) || details.url.match(/google.com\/*/) || details.url.match(/accounts.google.com\/*/) || details.url.match(/reddit.com\/*/) || details.url.match(/twitter.com\/*/)) {
            return
        }

        // Если пользователь авторизовывается через эти сайты, но у расширения на это нет прав, всё равно не мешаем ему, пускай сам авторизуется не смотря, на то что есть автоматизация авторизации
        if (details.url.match(/vk.com\/*/) || details.url.match(/discord.com\/*/) || details.url.startsWith('https://steamcommunity.com/openid/login')) {
            // noinspection JSUnresolvedFunction
            let granted = await chrome.permissions.contains({origins: [details.url]})
            if (!granted) {
                console.warn(getProjectPrefix(project, true) + 'Not granted permissions for ' + details.url)
                return
            }
        }

        let eval = true
        let textApi, textScript, textWorld
        if (!settings.disabledUseRemoteCode) {
            try {
                const responseApi = await fetch('https://serega007ru.github.io/Auto-Vote-Rating/scripts/main/api.js')
                textApi = await responseApi.text()
                const responseScript = await fetch('https://serega007ru.github.io/Auto-Vote-Rating/scripts/' + project.rating.toLowerCase() + '.js')
                textScript = await responseScript.text()
                if (allProjects[project.rating]('needWorld')) {
                    const responseWorld = await fetch('https://serega007ru.github.io/Auto-Vote-Rating/scripts/' + project.rating.toLowerCase() + '_world.js')
                    textWorld = await responseWorld.text()
                }
            } catch (error) {
                console.error(getProjectPrefix(project, true) + 'Ошибка при получении удалённого кода, использую вместо этого локальный код', error)
                eval = false
            }
        } else {
            eval = false
        }

        try {
            if (allProjects[project.rating]('needPrompt')) {
                const funcPrompt = function(nick) {
                    prompt = function() {
                        return nick
                    }
                }
                await chrome.scripting.executeScript({target: {tabId: details.tabId}, world: 'MAIN', func: funcPrompt, args: [project.nick]})
            }

            if (eval) {
                await chrome.scripting.executeScript({target: {tabId: details.tabId}, files: ['libs/evalCore.umd.js', 'scripts/main/injectEval.js']})
                await chrome.tabs.sendMessage(details.tabId, {textEval: true, textApi, textScript})
                if (allProjects[project.rating]('needWorld')) {
                    await chrome.scripting.executeScript({target: {tabId: details.tabId}, world: 'MAIN', files: ['libs/evalCore.umd.js']})
                    const funcWorld = function(text) {
                        // noinspection JSUnresolvedFunction,JSUnresolvedVariable
                        const evil = evalCore.getEvalInstance(window)
                        evil(text)
                    }
                    await chrome.scripting.executeScript({target: {tabId: details.tabId}, world: 'MAIN', func: funcWorld, args: [textWorld]})
                }
            } else {
                await chrome.scripting.executeScript({target: {tabId: details.tabId}, files: ['scripts/' + project.rating.toLowerCase() +'.js', 'scripts/main/api.js']})
                if (allProjects[project.rating]('needWorld')) {
                    await chrome.scripting.executeScript({target: {tabId: details.tabId}, world: 'MAIN', files: ['scripts/' + project.rating.toLowerCase() +'_world.js']})
                }
            }

            await chrome.tabs.sendMessage(details.tabId, {sendProject: true, project})
        } catch (error) {
            if (error.message !== 'The tab was closed.' && !error.message.includes('PrecompiledScript.executeInGlobal') && !error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                console.error(getProjectPrefix(project, true) + error.message)
                if (!settings.disabledNotifError) sendNotification(getProjectPrefix(project, false), error.message)
                project.error = error.message
                updateValue('projects', project)
            }
        }
    } else if (details.frameId !== 0 && (
        details.url.match(/hcaptcha.com\/captcha\/*/)
        || details.url.match(/https:\/\/www.google.com\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https:\/\/www.google.com\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api.\/anchor*/)
        || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api.\/bframe*/)
        || details.url.match(/https:\/\/www.google.com\/recaptcha\/api\/fallback*/)
        || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api\/fallback*/)
        || details.url.match(/https:\/\/challenges.cloudflare.com\/*/))) {

        // let eval = true
        // let textCaptcha
        // if (!settings.disabledUseRemoteCode) {
        //     try {
        //         const responseApi = await fetch('https://serega007ru.github.io/Auto-Vote-Rating/scripts/main/captchaclicker.js')
        //         textCaptcha = await responseApi.text()
        //     } catch (error) {
        //         console.error(getProjectPrefix(project, true) + 'Ошибка при получении удалённого кода, использую вместо этого локальный код', error)
        //         eval = false
        //     }
        // } else {
        //     eval = false
        // }

        try {
            // if (eval) {
            //     await chrome.scripting.executeScript({target: {tabId: details.tabId, frameIds: [details.frameId]}, files: ['libs/evalCore.umd.js', 'scripts/main/injectEval.js']})
            //     await chrome.tabs.sendMessage(details.tabId, {textEval: true, textCaptcha})
            // } else {
                await chrome.scripting.executeScript({target: {tabId: details.tabId, frameIds: [details.frameId]}, files: ['scripts/main/captchaclicker.js']})
            // }

            // Если вкладка уже загружена, повторно туда высылаем sendProject который обозначает что мы готовы к голосованию
            const tab = await chrome.tabs.get(details.tabId)
            if (tab.status !== 'complete') return
            await chrome.tabs.sendMessage(details.tabId, {sendProject: true, project})
        } catch (error) {
            if (error.message !== 'The frame was removed.' && !error.message.includes('No frame with id') && !error.message.includes('PrecompiledScript.executeInGlobal')/*Для FireFox мы игнорируем эту ошибку*/ && !error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                error = error.message
                if (error.includes('This page cannot be scripted due to an ExtensionsSettings policy')) {
                    error += ' Try this solution: https://github.com/Serega007RU/Auto-Vote-Rating/wiki/Problems-with-Opera'
                }
                console.error(getProjectPrefix(project, true) + error)
                if (!settings.disabledNotifError) sendNotification(getProjectPrefix(project, false), error.message)
                project.error = error
                updateValue('projects', project)
            }
        }
    }
})

chrome.tabs.onRemoved.addListener(async function(tabId) {
    await waitInitialize()
    const projectKey = openedProjects.get(tabId)
    if (!projectKey) return
    const project = await db.get('projects', projectKey)
    endVote({closedTab: true}, {tab: {id: tabId}}, project)
})

// TODO к сожалению в manifest v3 не возможно узнать status code страницы, не знаю как это ещё сделать
// chrome.webRequest.onCompleted.addListener(async function(details) {
//     await waitInitialize()
//     const projectKey = openedProjects.get(details.tabId)
//     if (!projectKey) return
//     const project = await db.get('projects', projectKey)
//
//     // TODO это какой-то кринж для https://www.minecraft-serverlist.net/, ошибка 500 считается как успешный запрос https://discord.com/channels/371699266747629568/760393040174120990/1053016256535593022
//     if (project.rating === 'MinecraftServerListNet') return
//
//     if (details.type === 'main_frame' && (details.statusCode < 200 || details.statusCode > 299) && details.statusCode !== 503 && details.statusCode !== 403/*Игнорируем проверку CloudFlare*/) {
//         const sender = {tab: {id: details.tabId}}
//         endVote({errorVote: [String(details.statusCode), details.url]}, sender, project)
//     }
// }, {urls: ['<all_urls>']})
//
// chrome.webRequest.onErrorOccurred.addListener(async function(details) {
//     await waitInitialize()
//     // noinspection JSUnresolvedVariable
//     if ((details.initiator && details.initiator.includes(self.location.hostname) || (details.originUrl && details.originUrl.includes(self.location.hostname))) && fetchProjects.has(details.requestId)) {
//         let project = fetchProjects.get(details.requestId)
//         endVote({errorVoteNetwork: [details.error, details.url]}, null, project)
//     } else if (openedProjects.has(details.tabId)) {
//         if (details.type === 'main_frame' || details.url.match(/hcaptcha.com\/captcha\/*/) || details.url.match(/https:\/\/www.google.com\/recaptcha\/*/) || details.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/*/)) {
//             const project = await db.get('projects', openedProjects.get(details.tabId))
//             if (
//                 //Chrome
//                 details.error.includes('net::ERR_ABORTED') || details.error.includes('net::ERR_CONNECTION_RESET') || details.error.includes('net::ERR_NETWORK_CHANGED') || details.error.includes('net::ERR_CACHE_MISS') || details.error.includes('net::ERR_BLOCKED_BY_CLIENT')
//                 //FireFox
//                 || details.error.includes('NS_BINDING_ABORTED') || details.error.includes('NS_ERROR_NET_ON_RESOLVED') || details.error.includes('NS_ERROR_NET_ON_RESOLVING') || details.error.includes('NS_ERROR_NET_ON_WAITING_FOR') || details.error.includes('NS_ERROR_NET_ON_CONNECTING_TO') || details.error.includes('NS_ERROR_FAILURE') || details.error.includes('NS_ERROR_DOCSHELL_DYING') || details.error.includes('NS_ERROR_NET_ON_TRANSACTION_CLOSE')) {
//                     // console.warn(getProjectPrefix(project, true) + details.error)
//                     return
//             }
//             const sender = {tab: {id: details.tabId}}
//             endVote({errorVoteNetwork: [details.error, details.url]}, sender, project)
//         }
//     }
// }, {urls: ['<all_urls>']})
//
// async function _fetch(url, options, project) {
//     let listener
//     const removeListener = ()=>{
//         if (listener) {
//             chrome.webRequest.onBeforeRequest.removeListener(listener)
//             listener = null
//         }
//     }
//
//     listener = (details)=>{
//         //Да это костыль, а есть другой адекватный вариант достать requestId или хотя бы код ошибки net::ERR из fetch запроса?
//         // noinspection JSUnresolvedVariable
//         if ((details.initiator && details.initiator.includes(self.location.hostname) || (details.originUrl && details.originUrl.includes(self.location.hostname))) && details.url.includes(url)) {
//             fetchProjects.set(details.requestId, project)
//             removeListener()
//         }
//     }
//     chrome.webRequest.onBeforeRequest.addListener(listener, {urls: ['<all_urls>']})
//
//     if (!options) options = {}
//
//     try {
//         return await fetch(url, options)
//     } catch(e) {
//         throw e
//     } finally {
//         removeListener()
//     }
// }

//Слушатель сообщений и ошибок
chrome.runtime.onMessage.addListener(async function(request, sender/*, sendResponse*/) {
    if (request === 'reloadCaptcha') {
        // noinspection JSVoidFunctionReturnValueUsed,JSCheckFunctionSignatures
        const frames = await chrome.webNavigation.getAllFrames({tabId: sender.tab.id})
        for (const frame of frames) {
            // noinspection JSUnresolvedVariable
            if (frame.url.match(/https:\/\/www.google.com\/recaptcha\/api\d\/anchor/) || frame.url.match(/https:\/\/www.recaptcha.net\/recaptcha\/api\d\/anchor/)) {
                function reload() {
                    document.location.reload()
                }

                // noinspection JSCheckFunctionSignatures,JSUnresolvedVariable
                await chrome.scripting.executeScript({target: {tabId: sender.tab.id, frameIds: [frame.frameId]}, func: reload})
            }
        }
        return
    } else if (request === 'captchaPassed') {
        try {
            await chrome.tabs.sendMessage(sender.tab.id, 'captchaPassed')
        } catch (error) {
            if (!error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                console.error(error)
            }
        }
        return
    }

    if (request === 'checkVote') {
        checkVote()
        return
    } else if (request === 'reloadAllSettings') {
        settings = await db.get('other', 'settings')
        generalStats = await db.get('other', 'generalStats')
        todayStats = await db.get('other', 'todayStats')
        openedProjects = await db.get('other', 'openedProjects')
        reloadAllAlarms()
        checkVote()
        return
    } else if (request === 'reloadSettings') {
        settings = await db.get('other', 'settings')
        return
    } else if (request.projectDeleted) {
        let nowVoting = false
        //Если эта вкладка была уже открыта, он закрывает её
        for (const[key,value] of openedProjects.entries()) {
            if (request.projectDeleted.key === value) {
                nowVoting = true
                openedProjects.delete(key)
                // noinspection JSCheckFunctionSignatures
                if (!isNaN(key)) { // noinspection JSCheckFunctionSignatures
                    chrome.tabs.remove(key)
                        .catch(error => {if (error.message !== 'No tab with id.') console.warn(error)})
                }
                break
            }
        }
        db.put('other', openedProjects, 'openedProjects')
        if (nowVoting) {
            checkVote()
            console.log(getProjectPrefix(request.projectDeleted, true) + chrome.i18n.getMessage('projectDeleted'))
        }
        return
    }

    if (request.changeProject) {
        updateValue('projects', request.changeProject)
        return
    }

    await waitInitialize()
    if (!openedProjects.has(sender.tab.id)) {
        console.warn('Пришёл нераспознанный chrome.runtime.message, что это?' + JSON.stringify(request))
        return
    }
    const project = await db.get('projects', openedProjects.get(sender.tab.id))
    if (request.captcha || request.authSteam || request.discordLogIn || request.auth) {//Если требует ручное прохождение капчи
        let message
        if (request.captcha) {
            if (settings.disabledWarnCaptcha) return
            message = chrome.i18n.getMessage('requiresCaptcha')
        } else if (request.auth && request.auth !== true) {
            message = request.auth
        } else {
            message = chrome.i18n.getMessage(Object.keys(request)[0])
        }
        console.warn(getProjectPrefix(project, true) + message)
        if (!settings.disabledNotifWarn) sendNotification(getProjectPrefix(project, false), message)
        project.error = message
        // delete project.nextAttempt
        updateValue('projects', project)
    } else if (request.errorCaptcha && !request.restartVote) {
        const message = chrome.i18n.getMessage('errorCaptcha', request.errorCaptcha)
        console.warn(getProjectPrefix(project, true) + message)
        if (!settings.disabledNotifWarn) sendNotification(getProjectPrefix(project, false), message)
        project.error = message
        updateValue('projects', project)
    } else {
        endVote(request, sender, project)
    }
})

async function tryCloseTab(tabId, project, attempt) {
    try {
        await chrome.tabs.remove(tabId)
    } catch (error) {
        if (error.message === 'Tabs cannot be edited right now (user may be dragging a tab).' && attempt < 3) {
            await wait(500)
            tryCloseTab(tabId, project, ++attempt)
            return
        }
        console.warn(getProjectPrefix(project, true) + error.message)
        if (!settings.disabledNotifError && error.message !== 'No tab with id.')
            sendNotification(getProjectPrefix(project, false), error.message)
    }
}

//Завершает голосование, если есть ошибка то обрабатывает её
async function endVote(request, sender, project) {
    if (sender && openedProjects.has(sender.tab.id)) {
        //Если сообщение доставлено из вкладки и если вкладка была открыта расширением
        project = await db.get('projects', openedProjects.get(sender.tab.id))
        if (closeTabs && !request.closedTab) {
            tryCloseTab(sender.tab.id, project, 0)
        }
        openedProjects.delete(sender.tab.id)
        db.put('other', openedProjects, 'openedProjects')
    } else if (!project) return

    // for (const[key,value] of fetchProjects.entries()) {
    //     if (value.key === project.key) {
    //         fetchProjects.delete(key)
    //     }
    // }

    delete project.nextAttempt

    //Если усё успешно
    let sendMessage
    if (request.successfully || request.later != null) {
        let time = new Date()
        if (project.rating !== 'Custom' && (project.timeout != null || project.timeoutHour != null) && !(project.lastDayMonth && new Date(time.getFullYear(), time.getMonth(), time.getDay() + 1).getMonth() === new Date().getMonth())) {
            if (project.timeoutHour != null) {
                if (project.timeoutMinute == null) project.timeoutMinute = 0
                if (project.timeoutSecond == null) project.timeoutSecond = 0
                if (project.timeoutMS == null) project.timeoutMS = 0
                if (time.getHours() > project.timeoutHour || (time.getHours() === project.timeoutHour && time.getMinutes() >= project.timeoutMinute)) {
                    time.setDate(time.getDate() + 1)
                }
                time.setHours(project.timeoutHour, project.timeoutMinute, project.timeoutSecond, project.timeoutMS)
            } else {
                time.setUTCMilliseconds(time.getUTCMilliseconds() + project.timeout)
            }
        } else if (request.later && Number.isInteger(request.later)) {
            time = new Date(request.later)
            if (project.rating === 'ServeurPrive' || project.rating === 'TopGames' || project.rating === 'MCServerList' || project.rating === 'CzechCraft' || project.rating === 'MinecraftServery' || project.rating === 'MinecraftListCZ' || project.rating === 'ListeServeursMinecraft' || project.rating === 'ServeursMCNet' || project.rating === 'ServeursMinecraftCom' || request.rating === 'ServeurMinecraftVoteFr' || request.rating === 'ListeServeursFr') {
                project.countVote = project.countVote + 1
                if (project.countVote >= project.maxCountVote) {
                    time = new Date()
                    time.setDate(time.getDate() + 1)
                    time.setHours(0, (project.priority ? 0 : 10), 0, 0)
                }
            }
        } else {
            //Рейтинги с таймаутом сбрасывающемся раз в день в определённый час
            let hour
            if (project.rating === 'TopCraft' || project.rating === 'McTOP' || (project.rating === 'MinecraftRating' && project.game === 'projects') || project.rating === 'MonitoringMinecraft' || project.rating === 'IonMc' || (project.rating === 'MisterLauncher' && project.game === 'projects')) {
                //Топы на которых время сбрасывается в 00:00 по МСК
                hour = 21
            } else if (project.rating === 'MCRate') {
                hour = 22
            } else if (project.rating === 'MinecraftServerList' || project.rating === 'ServerList101' || project.rating === 'MinecraftServerListNet' || project.rating === 'MinecraftServerEu') {
                hour = 23
            } else if (project.rating === 'PlanetMinecraft' || project.rating === 'ListForge' || project.rating === 'MinecraftList') {
                hour = 5
            } else if (project.rating === 'MinecraftServersOrg' || project.rating === 'MinecraftIndex' || project.rating === 'MinecraftBuzz' || project.rating === 'MineServers') {
                hour = 0
            } else if (project.rating === 'TopMinecraftServers') {
                hour = 4
            } else if (project.rating === 'MMoTopRU') {
                hour = 20
            }
            if (hour != null) {
                if (time.getUTCHours() >= hour/* || (time.getUTCHours() === hour && time.getUTCMinutes() >= (project.priority ? 0 : 10))*/) {
                    time.setUTCDate(time.getUTCDate() + 1)
                }
                time.setUTCHours(hour, (project.priority ? 0 : 10), 0, 0)
            //Рейтинги с таймаутом сбрасывающемся через определённый промежуток времени с момента последнего голосования
            } else if (project.rating === 'TopG' || project.rating === 'MinecraftServersBiz' || project.rating === 'TopGG' || project.rating === 'DiscordBotList' || project.rating === 'MCListsOrg' || (project.rating === 'Discords' && project.game === 'bots/bot') || project.rating === 'DiscordBoats' || project.rating === 'McServerTimeCom') {
                time.setUTCHours(time.getUTCHours() + 12)
            } else if (project.rating === 'MinecraftIpList' || project.rating === 'HotMC' || project.rating === 'MinecraftServerNet' || project.rating === 'TMonitoring' || project.rating === 'MCServers' || project.rating === 'CraftList' || project.rating === 'TopMCServersCom' || project.rating === 'CraftListNet' || project.rating === 'MinecraftServers100' || project.rating === 'MineStatus' || project.rating === 'MinecraftServersDe' || (project.rating === 'MinecraftRating' && project.game === 'servers') || (project.rating === 'MisterLauncher' && project.game === 'servers') || project.rating === 'ATLauncher' || project.rating === 'MCServidores' || project.rating === 'MinecraftServerSk' || project.rating === 'ServeursMinecraftOrg') {
                time.setUTCDate(time.getUTCDate() + 1)
            } else if (project.rating === 'ServeurPrive' || project.rating === 'TopGames' || project.rating === 'MCServerList' || project.rating === 'CzechCraft' || project.rating === 'MinecraftServery' || project.rating === 'MinecraftListCZ' || project.rating === 'ListeServeursMinecraft' || project.rating === 'ServeursMCNet' || project.rating === 'ServeursMinecraftCom' || project.rating === 'ServeurMinecraftVoteFr' || project.rating === 'ListeServeursFr') {
                project.countVote = project.countVote + 1
                if (project.countVote >= project.maxCountVote) {
                    time.setDate(time.getDate() + 1)
                    time.setHours(0, (project.priority ? 0 : 10), 0, 0)
                    project.countVote = 0
                } else {
                    if (project.rating === 'ServeurPrive' || project.rating === 'ServeurMinecraftVoteFr') {
                        time.setUTCHours(time.getUTCHours() + 1, time.getUTCMinutes() + 30)
                    } else if (project.rating === 'ListeServeursMinecraft' || project.rating === 'ServeursMinecraftCom' || project.rating === 'ListeServeursFr') {
                        time.setUTCHours(time.getUTCHours() + 3)
                    } else {
                        time.setUTCHours(time.getUTCHours() + 2)
                    }
                }
            } else if (project.rating === 'ServerPact') {
                time.setUTCHours(time.getUTCHours() + 11)
                time.setUTCMinutes(time.getUTCMinutes() + 7)
            } else if (project.rating === 'Custom') {
                if (project.timeoutHour != null) {
                    if (project.timeoutMinute == null) project.timeoutMinute = 0
                    if (project.timeoutSecond == null) project.timeoutSecond = 0
                    if (project.timeoutMS == null) project.timeoutMS = 0
                    if (time.getHours() > project.timeoutHour || (time.getHours() === project.timeoutHour && time.getMinutes() >= project.timeoutMinute)) {
                        time.setDate(time.getDate() + 1)
                    }
                    time.setHours(project.timeoutHour, project.timeoutMinute, project.timeoutSecond, project.timeoutMS)
                } else {
                    time.setUTCMilliseconds(time.getUTCMilliseconds() + project.timeout)
                }
            } else if (project.rating === 'CraftList') {
                time = new Date(request.successfully)
            } else if (project.rating === 'Discords' && project.game === 'servers') {
                time.setUTCHours(time.getUTCHours() + 6)
            } else if (project.rating === 'WARGM') {
                time.setUTCHours(time.getUTCHours() + 16)
            } else if (project.rating === 'ServerListGames') {
                time.setUTCHours(time.getUTCHours() + 20)
            } else {
                time.setUTCDate(time.getUTCDate() + 1)
            }
        }

        time = time.getTime()
        project.time = time

        if (project.randomize) {
            if (project.randomize.min == null) {
                project.randomize = {}
                project.randomize.min = 0
                project.randomize.max = 43200000
            }
            project.time = project.time + Math.floor(Math.random() * (project.randomize.max - project.randomize.min) + project.randomize.min)
        } else if ((project.rating === 'TopCraft' || project.rating === 'McTOP' || (project.rating === 'MinecraftRating' && project.game === 'projects')) && !project.priority && project.timeoutHour == null) {
            //Рандомизация по умолчанию (в пределах 5-10 минут) для бедного TopCraft/McTOP который легко ддосится от массового автоматического голосования
            project.time = project.time + Math.floor(Math.random() * (600000 - 300000) + 300000)
        }

        delete project.error

        if (request.successfully) {
            sendMessage = chrome.i18n.getMessage('successAutoVote')
            if (!settings.disabledNotifInfo) sendNotification(getProjectPrefix(project, false), sendMessage)

            project.stats.successVotes++
            project.stats.monthSuccessVotes++
            project.stats.lastSuccessVote = Date.now()

            generalStats.successVotes++
            generalStats.monthSuccessVotes++
            generalStats.lastSuccessVote = Date.now()
            todayStats.successVotes++
            todayStats.lastSuccessVote = Date.now()
        } else {
            sendMessage = chrome.i18n.getMessage('alreadyVoted')
//          if (typeof request.later == 'string') sendMessage = sendMessage + ' ' + request.later
            if (!settings.disabledNotifWarn) sendNotification(getProjectPrefix(project, false), sendMessage)

            project.stats.laterVotes++

            generalStats.laterVotes++
            todayStats.laterVotes++
        }
        console.log(getProjectPrefix(project, true) + sendMessage + ', ' + chrome.i18n.getMessage('timeStamp') + ' ' + project.time)
        //Если ошибка
    } else {
        let message
        if (!request.message) {
            if (Object.values(request)[0] === true) {
                message = chrome.i18n.getMessage(Object.keys(request)[0])
            } else {
                message = chrome.i18n.getMessage(Object.keys(request)[0], Object.values(request)[0])
            }
        } else {
            message = request.message
        }
        if (message.length === 0) message = chrome.i18n.getMessage('emptyError')
        let retryCoolDown
        if ((request.errorVote && request.errorVote[0] === '404') || (request.message && project.rating === 'WARGM' && project.randomize)) {
            retryCoolDown = 21600000
        } else if (request.closedTab) {
            retryCoolDown = 60000
        } else {
            retryCoolDown = settings.timeoutError
        }

        sendMessage = message + '. ' + chrome.i18n.getMessage('errorNextVote', (Math.round(retryCoolDown / 1000 / 60 * 100) / 100).toString())

        if (project.randomize) {
            retryCoolDown = retryCoolDown + Math.floor(Math.random() * 900000)
        }
        project.time = Date.now() + retryCoolDown
        project.error = message
        console.error(getProjectPrefix(project, true) + sendMessage + ', ' + chrome.i18n.getMessage('timeStamp') + ' ' + project.time)
        if (!settings.disabledNotifError && !(request.errorVote && request.errorVote[0].charAt(0) === '5')) sendNotification(getProjectPrefix(project, false), sendMessage)

        project.stats.errorVotes++

        generalStats.errorVotes++
        todayStats.errorVotes++
    }

    let timeout = settings.timeout
    if (project.randomize) {
        timeout += Math.floor(Math.random() * (60000 - 10000) + 10000)
    }
    project.timeoutQueue = timeout

    await db.put('other', generalStats, 'generalStats')
    await db.put('other', todayStats, 'todayStats')
    await updateValue('projects', project)

    await chrome.alarms.clear(String(project.key))
    if (project.time != null && project.time > Date.now()) {
        let create2 = true
        const alarms = await chrome.alarms.getAll()
        for (const alarm of alarms) {
            if (alarm.scheduledTime === project.time) {
                create2 = false
                break
            }
        }
        if (create2) {
            chrome.alarms.create(String(project.key), {when: project.time})
        }
    }

    function removeQueue() {
        for (const [tab,projectKey] of openedProjects) {
            if (project.key === projectKey) {
                openedProjects.delete(tab)
            }
        }
        if (openedProjects.size === 0) {
            promises = []
            if (updateAvailable) {
                chrome.runtime.reload()
                return
            }
        }
        delete project.timeoutQueue
        updateValue('projects', project)
        db.put('other', openedProjects, 'openedProjects')
        checkVote()
    }

    setTimeout(()=>{
        removeQueue()
    }, timeout)

    // TODO мы не можем быть уверены что setTimeout в Service Worker 100% отработает, поэтому мы на всякий случай создаём chrome.alarm
    let alarmTimeout = timeout
    if (alarmTimeout < 60000) alarmTimeout = 60000
    chrome.alarms.create('checkVote', {when: Date.now() + alarmTimeout})
}

//Отправитель уведомлений
function sendNotification(title, message) {
    if (!message) message = ''
    let notification = {
        type: 'basic',
        iconUrl: 'images/icon128.png',
        title: title,
        message: message
    }
    chrome.notifications.create('', notification, function() {})
}

function getProjectPrefix(project, detailed) {
    if (detailed) {
        return '[' + allProjects[project.rating]('URL', project) + '] ' + (project.nick != null && project.nick !== '' ? project.nick + ' – ' : '') + (project.game != null ? project.game + ' – ' : '') + project.id + (project.name != null ? ' – ' + project.name : '') + ' '
    } else {
        return '[' + allProjects[project.rating]('URL', project) + '] ' + (project.nick != null && project.nick !== '' ? project.nick + ' ' : '') + (project.name != null ? '– ' + project.name : '– ' + project.id)
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateValue(objStore, value) {
    const found = await db.count(objStore, value.key)
    if (found) {
        await db.put(objStore, value, value.key)
        try {
            await chrome.runtime.sendMessage({updateValue: objStore, value})
        } catch (error) {
            if (!error.message.includes('Could not establish connection. Receiving end does not exist') && !error.message.includes('The message port closed before a response was received')) {
                console.error(error)
            }
        }
    } else {
        console.warn('The ' + objStore + ' could not be found, it may have been deleted', JSON.stringify(value))
    }
}

chrome.runtime.onInstalled.addListener(async function(details) {
    await waitInitialize()
    console.log(chrome.i18n.getMessage('start', chrome.runtime.getManifest().version))
    if (details.reason === 'install') {
        chrome.tabs.create({url: 'options.html?installed'})
    } else if (details.reason === 'update') {
        checkVote()
    }/* else if (details.reason === 'update' && details.previousVersion && (new Version(details.previousVersion)).compareTo(new Version('6.0.0')) === -1) {

    }*/
})

chrome.runtime.onUpdateAvailable.addListener(async function() {
    await waitInitialize()
    if (openedProjects.size > 0) {
        updateAvailable = true
    } else {
        chrome.runtime.reload()
    }
})

// function Version(s){
//   this.arr = s.split('.').map(Number)
// }
// Version.prototype.compareTo = function(v){
//     for (let i=0; ;i++) {
//         if (i>=v.arr.length) return i>=this.arr.length ? 0 : 1
//         if (i>=this.arr.length) return -1
//         const diff = this.arr[i]-v.arr[i]
//         if (diff) return diff>0 ? 1 : -1
//     }
// }


/* Store the original log functions. */
console._log = console.log
console._info = console.info
console._warn = console.warn
console._error = console.error
console._debug = console.debug

/* Redirect all calls to the collector. */
console.log = function () { return console._intercept('log', arguments) }
console.info = function () { return console._intercept('info', arguments) }
console.warn = function () { return console._intercept('warn', arguments) }
console.error = function () { return console._intercept('error', arguments) }
console.debug = function () { return console._intercept('debug', arguments) }

/* Give the developer the ability to intercept the message before letting
   console-history access it. */
console._intercept = function (type, args) {
    // Your own code can go here, but the preferred method is to override this
    // function in your own script, and add the line below to the end or
    // begin of your own 'console._intercept' function.
    // REMEMBER: Use only underscore console commands inside _intercept!
    console._collect(type, args)
}

console._collect = function (type, args) {
    const time = new Date().toLocaleString().replace(',', '')

    if (!type) type = 'log'

    if (!args || args.length === 0) return

    console['_' + type].apply(console, args)

    let log = '[' + time + ' ' + type.toUpperCase() + ']:'

    for (let arg of args) {
        if (typeof arg != 'string') arg = JSON.stringify(arg)
        log += ' ' + arg
    }

    if (dbLogs) dbLogs.add('logs', log)
}

/*
Открытый репозиторий:
https://github.com/Serega007RU/Auto-Vote-Rating/
*/