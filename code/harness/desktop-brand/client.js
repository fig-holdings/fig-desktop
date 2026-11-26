window.__ModuleLoader__.load({
  id: '@local/dsh-desktop-brand',
  factory(require) {
    const { createElement, useLayoutEffect, useRef } = require('react')
    const icon = __FIG_BRAND_ICON__
    const darkIcon = __FIG_BRAND_ICON_DARK__

    function renderMark({ src, size, className }, placement, ref) {
      return createElement('img', { src, width: size, height: size, className, ref, alt: '', 'data-fig-brand': placement })
    }

    // The title sits in the desktop top bar, outside the sidebar; the desktop shell (app/main/workbench.css) owns its
    // traffic-light spacing and hides it while the sidebar is collapsed or the window is full screen.
    function DesktopTitle() {
      useLayoutEffect(() => {
        const title = document.createElement('span')
        title.dataset.figProductTitle = ''
        const name = document.createElement('strong')
        name.textContent = 'Fig'
        const edition = document.createElement('span')
        edition.textContent = 'Desktop'
        title.append(name, document.createTextNode(' '), edition)
        document.body.append(title)
        return () => title.remove()
      }, [])
      return null
    }

    function WelcomeMark({ size, className, t, brandText, useTheme }) {
      const scheme = useTheme(snapshot => snapshot.active.colorScheme)
      const mark = useRef(/** @type {HTMLImageElement | null} */ (null))
      const variant = useRef(/** @type {number | null} */ (null))
      if (variant.current === null) variant.current = Math.random() < 0.5 ? 0 : 1

      useLayoutEffect(() => {
        // DSH exposes a mark slot but renders the headline itself.
        const titleGroup = mark.current?.closest('span')?.nextElementSibling
        if (titleGroup?.children.length !== 2) return

        const headline = titleGroup.firstElementChild
        if (!headline || headline.textContent !== t('hero.headline')) return
        let appliedHeadline
        const subtitle = document.createElement('span')
        subtitle.dataset.figWelcomeSubtitle = ''
        subtitle.textContent = brandText(`welcomeSubtitle${variant.current}`)
        titleGroup.append(subtitle)
        titleGroup.setAttribute('data-fig-welcome', String(variant.current))
        headline.setAttribute('data-fig-welcome-headline', '')

        const replaceHeadline = () => {
          const text = headline.firstChild
          if (!(text instanceof Text)) return
          if (text.data !== t('hero.headline') && text.data !== appliedHeadline) return
          appliedHeadline = brandText(`welcomeHeadline${variant.current}`)
          if (text.data !== appliedHeadline) text.data = appliedHeadline
        }

        replaceHeadline()
        const observer = new MutationObserver(replaceHeadline)
        observer.observe(headline, { childList: true, characterData: true, subtree: true })
        return () => {
          observer.disconnect()
          subtitle.remove()
          titleGroup.removeAttribute('data-fig-welcome')
          headline.removeAttribute('data-fig-welcome-headline')
          const text = headline.firstChild
          if (text instanceof Text && text.data === appliedHeadline) text.data = t('hero.headline')
        }
      }, [t, brandText])

      return renderMark({ src: scheme === 'dark' ? darkIcon : icon, size, className }, 'hero-mark', mark)
    }

    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('fig.brand', {
          zh: {
            welcomeHeadline0: '今天，从哪件事开始？',
            welcomeSubtitle0: '继续手头的项目，或开始一件新事。',
            welcomeHeadline1: '有个想法？一起试试。',
            welcomeSubtitle1: '从一个问题、一份材料或一个项目开始。'
          },
          en: {
            welcomeHeadline0: 'Where would you like to start today?',
            welcomeSubtitle0: 'Pick up a project, or start something new.',
            welcomeHeadline1: 'Have an idea? Let’s try it out.',
            welcomeSubtitle1: 'Start with a question, a document, or a project.'
          }
        }))
        const brandText = ctx.locale.bind('fig.brand')

        // Branding moves to the desktop title bar; neither sidebar slot draws a logo.
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
          { name: 'sidebar.brand.mark', priority: -100 },
          () => null
        ))
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
          { name: 'sidebar.brand.name', priority: -100 },
          DesktopTitle
        ))
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
          {
            name: 'conversation.hero.brand.mark',
            priority: -100,
            locale: 'conversation',
            inject: () => ({
              brandText,
              hooks: {
                theme: {
                  getSnapshot: () => ctx.theme.getTheme(),
                  subscribe: listener => ctx.on('theme/change', listener)
                }
              }
            })
          },
          WelcomeMark
        ))
      }
    }
  }
})
