interface PageHeaderProps {
  title: string
  description: string
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <h1 className="text-3xl font-bold text-primary mb-2">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
    </div>
  )
}
