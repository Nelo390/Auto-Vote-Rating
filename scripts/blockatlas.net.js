async function vote(first) {


        if (document.querySelector('#vote_success_tab').getAttribute('style') !== "display: none;") {
            chrome.runtime.sendMessage({successfully: true})
            return
        }
        /* idk what to do better for bottom, it redirects.
        if (document.querySelector('#vote_success_tab').getAttribute('style') !== "display: none;") {
            chrome.runtime.sendMessage({later: true})
            return
        }
        */
    
    
        console.log("before await")
        const project = await getProject()
        console.log("After await")
        if (document.querySelector('input[name="username"]')) { 
            document.querySelector('input[name="username"]').value = project.nick
            document.querySelector('.vote-button').click()
        }
        chrome.runtime.sendMessage({captcha: true})
    
    }