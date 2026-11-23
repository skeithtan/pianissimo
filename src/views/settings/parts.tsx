/** Small layout pieces shared by the settings sections. */
import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'
import styles from './settings.module.css'

/** A named part of a tab: heading, one line about it, then its blocks. */
export function Section({ title, intro, children }: { title: string; intro?: string; children: ComponentChildren }) {
  const id = useId()
  return (
    <section class={styles.part} aria-labelledby={id}>
      <header class={styles.sectionHead}>
        <h3 id={id}>{title}</h3>
        {intro ? <p>{intro}</p> : null}
      </header>
      {children}
    </section>
  )
}

/** A titled block inside a section. */
export function Group({ title, children }: { title?: string; children: ComponentChildren }) {
  return (
    <div class={styles.group}>
      {title ? <h4 class={styles.groupTitle}>{title}</h4> : null}
      {children}
    </div>
  )
}

/**
 * A labeled control with optional explanation. The label names the control group so a screen
 * reader hears it with the segmented control or slider inside.
 */
export function Setting({
  label,
  description,
  children,
}: {
  label: string
  description?: ComponentChildren
  children: ComponentChildren
}) {
  const id = useId()
  return (
    <div class={styles.setting} role="group" aria-labelledby={id}>
      <div class={styles.settingHead}>
        <span id={id} class={styles.settingLabel}>
          {label}
        </span>
        {description ? <span class={styles.settingHelp}>{description}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** Muted explanatory paragraph. */
export function Help({ children }: { children: ComponentChildren }) {
  return <p class={styles.help}>{children}</p>
}
