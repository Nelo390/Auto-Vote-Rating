async function vote(/*first*/) {
    if (document.querySelector('div.nk-info-box.text-success.nk-info-box-noicon')) {
        chrome.runtime.sendMessage({successfully: true})
        return
    }
    if (document.querySelector('div.container div.col-lg-5').textContent.includes('can vote again')) {
        chrome.runtime.sendMessage({later: true})
        return
    }
    if (document.querySelector('div.nk-info-box.text-danger.nk-info-box-noicon')) {
        const request = {}
        request.message = document.querySelector('div.nk-info-box.text-danger.nk-info-box-noicon').textContent
        if (request.message.toLowerCase().includes('captcha')) {
            // None
        } else {
            chrome.runtime.sendMessage(request)
            return
        }
    }

    const project = await getProject()
    if (document.querySelector('form[method="POST"] > input[name="username"]')) {
        document.querySelector('form[method="POST"] > input[name="username"]').value = project.nick
    }
    chrome.runtime.sendMessage({captcha: true})

    // if (first) return
    //
    // if (document.querySelector('form[method="POST"] > input[name="username"]')) {
    //     const project = await getProject('ServerList101')
    //     document.querySelector('form[method="POST"] > input[name="username"]').value = project.nick
    // }
    // document.querySelector('form[method="POST"] > input[type="submit"]').click()
}
