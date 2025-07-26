resource "azurerm_resource_group" "rg" {
  name     = "project4RG"
  location = "canadacentral"
}

resource "azurerm_service_plan" "plan" {
  name                = "project4Plan"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "B1"
  os_type             = "Linux"
}

resource "azurerm_linux_web_app" "app" {
  name                = "realtime-node-app"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  service_plan_id     = azurerm_service_plan.plan.id

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "18-lts"
    }
  }

  app_settings = {
    "WEBSITE_RUN_FROM_PACKAGE"     = "1"
    "WEBSITE_NODE_DEFAULT_VERSION" = "~18"
    "KEYVAULT_NAME"                = "project4KeyVault321"
  }
}

resource "azurerm_mssql_server" "sql" {
  name                         = "project4sqlserver123"
  resource_group_name          = azurerm_resource_group.rg.name
  location                     = azurerm_resource_group.rg.location
  version                      = "12.0"
  administrator_login          = var.db_admin
  administrator_login_password = var.db_password
}

resource "azurerm_mssql_database" "db" {
  name           = "project4db"
  server_id      = azurerm_mssql_server.sql.id
  collation      = "SQL_Latin1_General_CP1_CI_AS"
  sku_name       = "S0"
}
